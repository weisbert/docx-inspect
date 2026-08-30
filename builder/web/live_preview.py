# -*- coding: utf-8 -*-
"""live_preview.py -- turn ONE section of a report into page images, fast.

Pipeline (measured on the development machine, warm):

    engine section-only .docx      0.04 - 0.11 s
    resident Word -> PDF           0.39 - 0.59 s
    PyMuPDF -> PNG per page        0.04 - 0.06 s
                                   -----------
                                   0.5  - 0.7  s end to end

Word's ~4 s cold start is paid once, because the instance stays resident between
requests and is only dropped after an idle timeout.

Public API (web/server.py calls exactly these):

    render_section(project_dir, cfg, node_id) -> {"pages": [{"png_b64", "w", "h"}],
                                                  "ms": int, ...}
    shutdown()                                  # idempotent, safe at process exit
    status()  -> {"alive", "pid", "started", "renders", ...}

Two properties matter more than speed.

1. PROCESS SAFETY.  The people using this tool write their documents in Word and
   almost certainly have unsaved work open.  So:

   * the instance is created with ``DispatchEx`` -- a brand new process that is
     ours alone.  ``Dispatch`` / ``GetActiveObject`` would attach to the running
     copy of Word on the desktop, and quitting that would throw away the user's
     work, so neither is ever used here;
   * the process id of the instance we created is written to a pid file under the
     report's ``_preview/`` directory together with the process CREATION TIME, so
     an id that Windows later recycles for an unrelated process can never be
     mistaken for ours;
   * cleanup only ever considers ids recorded in that file whose creation time
     still matches.  Nothing in this module enumerates processes or kills by image
     name; the only image lookup asks the kernel about ONE handle -- the id just
     captured -- to confirm it really is the Word process that was started.

2. IMPORTABILITY.  The module must import cleanly on a machine with no Word and no
   pywin32 -- the approximate preview has to keep working there.  Every optional
   dependency is imported inside a function, and a missing one surfaces as
   ``LivePreviewUnavailable`` carrying a plain-English reason.

Threading: the HTTP server is threaded, and a COM object may not be passed between
apartments, so all COM work happens on one dedicated worker thread that calls
``CoInitialize`` once.  Callers hand it a job and wait.  A render lock in front of
that keeps it to one render at a time.
"""

import atexit
import base64
import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time

# The layer directories (core, docx_io, store, sync, web) must be importable so
# that ``import engine`` works when this module is loaded on its own -- e.g. from
# a test -- and not only from the server entry point, which registers them first.
try:
    _BUILDER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if _BUILDER_ROOT not in sys.path:
        sys.path.insert(0, _BUILDER_ROOT)
    import buildpath  # noqa: F401  (side effect: registers the layer directories)
except Exception:       # pragma: no cover - a caller may have set sys.path already
    pass


# ---------------------------------------------------------------------------
# Tunables (environment overrides keep them out of the front end's way)
# ---------------------------------------------------------------------------
def _env_float(name, default):
    try:
        return float(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default


#: Seconds an idle Word instance is kept resident before it is told to quit.
IDLE_TIMEOUT = _env_float("WORKBENCH_PREVIEW_IDLE", 300.0)
#: Rasterisation resolution.  144 dpi is two screen pixels per point: sharp when
#: the page is shown at half size, still well under a megabyte per page.
RENDER_DPI = _env_float("WORKBENCH_PREVIEW_DPI", 144.0)
#: How long a caller waits for the worker thread to finish a COM job.
COM_JOB_TIMEOUT = _env_float("WORKBENCH_PREVIEW_JOB_TIMEOUT", 180.0)
#: How long a graceful Quit is given before the recorded pid is terminated.
QUIT_GRACE = _env_float("WORKBENCH_PREVIEW_QUIT_GRACE", 8.0)
#: How far a process creation time may sit before the moment ``DispatchEx`` was
#: called and still be believable as the instance that call created.  Only ever
#: used to REJECT: anything older than this predates our own start and cannot be
#: ours.  Measured gap on a real start: 0.005 s.
_SPAWN_CLOCK_SLACK = 5.0

#: Name of the pid file inside a report's ``_preview/`` directory.
PIDFILE_NAME = "word_pids.json"
PREVIEW_DIRNAME = "_preview"

# Win32 access rights, spelled out so no extra import is needed to read this.
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_QUERY_INFORMATION = 0x0400
_PROCESS_VM_READ = 0x0010
_PROCESS_TERMINATE = 0x0001
_SYNCHRONIZE = 0x00100000
_STILL_ACTIVE = 259         # GetExitCodeProcess's "has not exited yet"
_WD_EXPORT_FORMAT_PDF = 17
#: The executable an instance of Word runs as; the captured id must name this.
_WORD_IMAGE_NAME = "WINWORD.EXE"


class LivePreviewUnavailable(RuntimeError):
    """Raised when page images cannot be produced on this machine.

    ``reason`` is a plain-English sentence meant to be shown to the user, e.g.
    "Word is not available on this machine".
    """

    def __init__(self, reason):
        RuntimeError.__init__(self, reason)
        self.reason = reason


# ---------------------------------------------------------------------------
# Capability probe
# ---------------------------------------------------------------------------
def _capability_error():
    """Return a plain-English reason page images are impossible, or None.

    Only checks what can be checked without starting anything: the platform,
    pywin32 and PyMuPDF.  Whether Word itself is installed is only knowable by
    trying, and that answer comes from ``_start_word``.
    """
    if os.name != "nt":
        return ("Word page images need Windows; this server is running on %s."
                % sys.platform)
    try:
        import pythoncom        # noqa: F401
        import win32api         # noqa: F401
        import win32com.client  # noqa: F401
        import win32event       # noqa: F401
        import win32process     # noqa: F401
    except ImportError as exc:
        return ("pywin32 is not installed, so the server cannot drive Word "
                "(pip install pywin32). Details: %s" % exc)
    try:
        import fitz             # noqa: F401
    except ImportError as exc:
        return ("PyMuPDF is not installed, so PDF pages cannot be turned into "
                "images (pip install pymupdf). Details: %s" % exc)
    return None


def available():
    """True when a page-image render could be attempted on this machine."""
    return _capability_error() is None


# ---------------------------------------------------------------------------
# Process bookkeeping: pid + creation time, never an image name
# ---------------------------------------------------------------------------
def _process_info(pid):
    """``(creation time, still running)`` for ``pid``, or None if unreachable.

    Both halves are needed. A process that has already exited stays queryable for
    as long as anybody holds a handle to it, and it keeps reporting its original
    creation time -- so creation time alone would say "yes, still ours" about a
    process that ended seconds ago. ``STILL_ACTIVE`` separates the two.
    """
    import win32api
    import win32process
    try:
        handle = win32api.OpenProcess(
            _PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    except Exception:
        return None
    try:
        times = win32process.GetProcessTimes(handle)
        created = float(times["CreationTime"].timestamp())
        running = win32process.GetExitCodeProcess(handle) == _STILL_ACTIVE
        return created, running
    except Exception:
        return None
    finally:
        try:
            win32api.CloseHandle(handle)
        except Exception:
            pass


def _process_created(pid):
    """Creation time of a RUNNING process as a POSIX timestamp, else None.

    A pid on its own is not an identity -- Windows reuses them -- so every place
    that could terminate something pairs the id with this value.
    """
    info = _process_info(pid)
    if info is None or not info[1]:
        return None
    return info[0]


def _process_matches(pid, created):
    """True when ``pid`` is still the very process that was recorded, running.

    The comparison is EXACT.  Both sides come from the same source -- the
    CreationTime that ``GetProcessTimes`` reports -- so for one process they are
    the same number every time, and the pid file round-trips it through JSON
    without losing a digit.  A tolerance would therefore buy nothing while
    widening the band in which an unrelated process is mistaken for ours, and
    everything this answers True about is a candidate for termination.  When it
    is wrong it is wrong safely: a stale record is left alone rather than shot.
    """
    if not pid or created is None:
        return False
    now = _process_created(pid)
    return now is not None and now == float(created)


def _window_pid(hwnd):
    """Process id behind a window that is STILL OPEN, or None.

    ``GetWindowThreadProcessId`` reports failure through its RETURN value: a
    thread id of 0 means the handle names no window.  The process id is an out
    parameter, and on failure Windows leaves it untouched -- pywin32 hands back
    whatever happened to be in that slot, an arbitrary number rather than zero
    (measured: -613677680 for a handle whose window had just been destroyed).
    So the thread id is the thing that has to be checked, and a handle whose
    window is gone yields None here instead of a stranger's id.

    Window handles are recycled within a session, which is why this must only
    ever be asked about a live window: ask a moment too late and the answer can
    be somebody else's process -- most plausibly one of the user's own Word
    windows, which open and close all day.
    """
    import win32process
    try:
        thread_id, pid = win32process.GetWindowThreadProcessId(int(hwnd))
    except Exception:
        return None
    if not thread_id or not pid or int(pid) <= 0:
        return None
    return int(pid)


def _process_image(pid):
    """Full path of the executable behind ``pid``, or None if unreadable.

    Asks the kernel about ONE process, by handle.  Nothing here walks the
    process table or searches for an image name.
    """
    import win32api
    import win32process
    for rights in (_PROCESS_QUERY_LIMITED_INFORMATION,
                   _PROCESS_QUERY_INFORMATION | _PROCESS_VM_READ):
        try:
            handle = win32api.OpenProcess(rights, False, int(pid))
        except Exception:
            continue
        try:
            return win32process.GetModuleFileNameEx(handle, 0)
        except Exception:
            continue
        finally:
            try:
                win32api.CloseHandle(handle)
            except Exception:
                pass
    return None


def _wait_for_exit(pid, created, timeout):
    """Wait up to ``timeout`` seconds for a recorded process to end.

    Returns True if it is gone.  Polls the (pid, creation time) pair rather than
    holding a wait handle, so a recycled id cannot report the wrong process.
    """
    deadline = time.time() + max(0.0, timeout)
    while time.time() < deadline:
        if not _process_matches(pid, created):
            return True
        time.sleep(0.1)
    return not _process_matches(pid, created)


def _terminate_recorded(pid, created):
    """Terminate a process ONLY if it is still the one that was recorded.

    Returns True when the process is gone afterwards.  This is the single place
    in the module that can end a process, and it refuses to act on anything whose
    creation time no longer matches -- which is what makes a recycled id safe.
    """
    import win32api
    if not _process_matches(pid, created):
        return True         # already gone, or the id now belongs to someone else
    try:
        handle = win32api.OpenProcess(
            _PROCESS_TERMINATE | _SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION,
            False, int(pid))
    except Exception:
        return not _process_matches(pid, created)
    try:
        win32api.TerminateProcess(handle, 0)
    except Exception:
        pass
    finally:
        try:
            win32api.CloseHandle(handle)
        except Exception:
            pass
    return _wait_for_exit(pid, created, 5.0)


# ---------------------------------------------------------------------------
# The pid file: <report>/_preview/word_pids.json
# ---------------------------------------------------------------------------
def preview_dir(project_dir):
    """The report's private preview directory (created on demand)."""
    path = os.path.join(project_dir, PREVIEW_DIRNAME)
    os.makedirs(path, exist_ok=True)
    return path


def _pidfile(project_dir):
    return os.path.join(preview_dir(project_dir), PIDFILE_NAME)


def _read_pidfile(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    entries = data.get("entries") if isinstance(data, dict) else data
    return [e for e in (entries or []) if isinstance(e, dict) and e.get("pid")]


def _write_pidfile(path, entries):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "entries": entries}, fh, indent=1)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _self_entry(pid, created, tempdir):
    return {
        "pid": int(pid),
        "created": float(created),
        "started": time.time(),
        "host_pid": os.getpid(),
        "host_created": _process_created(os.getpid()),
        "tempdir": tempdir,
    }


def _record_pid(project_dir, entry):
    """Add (or refresh) our instance's record in one report's pid file."""
    path = _pidfile(project_dir)
    entries = [e for e in _read_pidfile(path) if int(e.get("pid", 0)) != entry["pid"]]
    entries.append(entry)
    _write_pidfile(path, entries)


def _forget_pid(project_dir, pid):
    path = _pidfile(project_dir)
    entries = _read_pidfile(path)
    keep = [e for e in entries if int(e.get("pid", 0)) != int(pid)]
    if len(keep) != len(entries):
        _write_pidfile(path, keep)


def _host_still_running(entry):
    """True when the server process that recorded this entry is still alive.

    Two servers may share a reports folder.  Their instances must not shoot each
    other, so an entry belonging to a live foreign host is left alone; it expires
    when that host exits.
    """
    host_pid = entry.get("host_pid")
    if not host_pid or int(host_pid) == os.getpid():
        return False
    return _process_matches(host_pid, entry.get("host_created"))


def sweep_stale(project_dir, keep_pid=None):
    """Clean up instances a previous run of this server left behind.

    Only pids written to this report's pid file are considered, and only those
    whose recorded creation time still matches the live process.  Anything else
    -- including every other copy of Word on the machine, which is where the
    user's own unsaved documents live -- is untouched.

    Returns the list of pids actually terminated.
    """
    path = _pidfile(project_dir)
    entries = _read_pidfile(path)
    if not entries:
        return []
    killed, keep = [], []
    for entry in entries:
        pid = int(entry.get("pid", 0) or 0)
        created = entry.get("created")
        if not pid or pid == os.getpid():
            continue                                    # never ourselves
        if keep_pid and pid == int(keep_pid):
            keep.append(entry)                          # our own live instance
            continue
        if _host_still_running(entry):
            keep.append(entry)                          # another server owns it
            continue
        if not _process_matches(pid, created):
            _remove_tree(entry.get("tempdir"))
            continue                                    # gone, or the id was reused
        if _terminate_recorded(pid, created):
            killed.append(pid)
            _remove_tree(entry.get("tempdir"))
        else:
            keep.append(entry)                          # not ended; keep tracking it
    _write_pidfile(path, keep)
    return killed


def _remove_tree(path):
    """Best-effort recursive delete; Word can hold a file open a moment longer."""
    if not path or not os.path.isdir(path):
        return
    for _ in range(3):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.isdir(path):
            return
        time.sleep(0.2)


# ---------------------------------------------------------------------------
# Worker thread: the only thread that ever touches COM
# ---------------------------------------------------------------------------
class _Job(object):
    __slots__ = ("fn", "done", "value", "error")

    def __init__(self, fn):
        self.fn = fn
        self.done = threading.Event()
        self.value = None
        self.error = None


_QUEUE = queue.Queue()
_WORKER = None
_WORKER_LOCK = threading.Lock()
_RENDER_LOCK = threading.RLock()

# State owned by the worker thread (read-only elsewhere).
_APP = None                 # the Word.Application COM object
_APP_PID = None
_APP_CREATED = None
_APP_STARTED = None
_APP_TEMPDIR = None
_LAST_USED = 0.0
_RENDERS = 0
_LAST_REASON = None         # why the last start attempt failed, for status()
_TRACKED_DIRS = set()       # reports whose pid file carries our record


def _ensure_worker():
    global _WORKER
    with _WORKER_LOCK:
        if _WORKER is not None and _WORKER.is_alive():
            return _WORKER
        _WORKER = threading.Thread(target=_worker_loop, name="live-preview-word",
                                   daemon=True)
        _WORKER.start()
        return _WORKER


def _worker_loop():
    import pythoncom
    pythoncom.CoInitialize()
    try:
        while True:
            try:
                job = _QUEUE.get(timeout=1.0)
            except queue.Empty:
                _idle_check()
                continue
            if job is None:                 # shutdown sentinel
                return
            try:
                job.value = job.fn()
            except BaseException as exc:    # carried back to the caller intact
                job.error = exc
            finally:
                job.done.set()
    finally:
        try:
            _quit_word()
        finally:
            pythoncom.CoUninitialize()


def _submit(fn, timeout=None):
    """Run ``fn`` on the worker thread and return its value (or re-raise)."""
    _ensure_worker()
    limit = COM_JOB_TIMEOUT if timeout is None else timeout
    job = _Job(fn)
    _QUEUE.put(job)
    if not job.done.wait(limit):
        raise LivePreviewUnavailable(
            "Word did not answer within %ds. It may be waiting on a dialog; the "
            "instance is restarted on the next attempt." % int(limit))
    if job.error is not None:
        raise job.error
    return job.value


def _idle_check():
    """Quit a resident instance nobody has used for a while (worker thread)."""
    if _APP is None:
        return
    if IDLE_TIMEOUT > 0 and (time.time() - _LAST_USED) > IDLE_TIMEOUT:
        _quit_word()


def heartbeat():
    """Mark the instance as in use so the idle timeout does not reclaim it."""
    global _LAST_USED
    _LAST_USED = time.time()


# ---------------------------------------------------------------------------
# Starting and stopping Word (worker thread only)
# ---------------------------------------------------------------------------
#: Shown when the id of the instance just started cannot be established beyond
#: doubt. Refusing costs a preview; recording a guess costs somebody's documents.
_UNIDENTIFIED = ("Word started but the server could not establish which process "
                 "it is, so the instance was dropped rather than recorded. Page "
                 "images are unavailable; the approximate preview still works.")


def _identify_instance(app):
    """Process id of the instance ``app`` drives, or None.  Worker thread only.

    A process id is only reachable through a document window, so a throwaway
    blank document is opened, the id read WHILE THAT WINDOW IS STILL OPEN, and
    the document closed afterwards.  The order is the whole point: closing first
    and reading second asks Windows about a handle it has already taken back, and
    a handle taken back can already belong to another process's window.
    """
    blank = app.Documents.Add()
    try:
        return _window_pid(app.ActiveWindow.Hwnd)
    finally:
        blank.Close(False)


def _start_word(project_dir):
    """Create OUR OWN Word process and record its identity.  Worker thread only.

    ``DispatchEx`` is deliberate: it always creates a new process.  ``Dispatch``
    or ``GetActiveObject`` would hand back the copy of Word the user is typing in,
    and quitting that would close their documents.
    """
    global _APP, _APP_PID, _APP_CREATED, _APP_STARTED, _APP_TEMPDIR, _LAST_REASON
    import win32com.client

    reason = _capability_error()
    if reason:
        _LAST_REASON = reason
        raise LivePreviewUnavailable(reason)

    # Read before the process exists: nothing this call creates can be older.
    spawned_after = time.time()
    try:
        app = win32com.client.DispatchEx("Word.Application")
    except Exception as exc:
        _LAST_REASON = "Word is not available on this machine (%s)." % exc
        raise LivePreviewUnavailable(_LAST_REASON)

    scratch = None
    try:
        app.Visible = False
        app.DisplayAlerts = 0
        pid = _identify_instance(app)
        created = _process_created(pid) if pid else None
        # Everything below refuses rather than guesses. A wrong id here is not a
        # broken preview, it is the idle watchdog terminating a process this
        # server never started -- and the likeliest such process is the Word the
        # user has their own unsaved work open in.
        if pid is None or created is None:
            raise LivePreviewUnavailable(_UNIDENTIFIED)
        if created < spawned_after - _SPAWN_CLOCK_SLACK:
            # Older than our own start, so it cannot be what we just created.
            raise LivePreviewUnavailable(_UNIDENTIFIED)
        image = os.path.basename(_process_image(pid) or "")
        if image.upper() != _WORD_IMAGE_NAME:
            raise LivePreviewUnavailable(_UNIDENTIFIED)
        scratch = tempfile.mkdtemp(prefix="word_", dir=preview_dir(project_dir))
    except Exception:
        # Never leave behind a process we could not record.
        try:
            app.Quit()
        except Exception:
            pass
        _remove_tree(scratch)
        raise

    _APP = app
    _APP_PID = pid
    _APP_CREATED = created
    _APP_STARTED = time.time()
    _APP_TEMPDIR = scratch
    _LAST_REASON = None
    heartbeat()
    _track(project_dir)
    return app


def _track(project_dir):
    """Record our live instance in this report's pid file."""
    if _APP_PID is None:
        return
    key = os.path.abspath(project_dir)
    if key in _TRACKED_DIRS:
        return
    _record_pid(project_dir, _self_entry(_APP_PID, _APP_CREATED, _APP_TEMPDIR))
    _TRACKED_DIRS.add(key)


def _quit_word():
    """Stop our instance and drop its records.  Worker thread (or shutdown)."""
    global _APP, _APP_PID, _APP_CREATED, _APP_STARTED, _APP_TEMPDIR
    app, pid, created, scratch = _APP, _APP_PID, _APP_CREATED, _APP_TEMPDIR
    _APP = None
    _APP_PID = _APP_CREATED = _APP_STARTED = None
    _APP_TEMPDIR = None
    if app is not None:
        try:
            app.Quit()
        except Exception:
            pass
        del app
    if pid is not None:
        if not _wait_for_exit(pid, created, QUIT_GRACE):
            # Quit did not take (a modal dialog, say). Terminate the one process
            # we created, identified by pid AND creation time.
            _terminate_recorded(pid, created)
        for directory in list(_TRACKED_DIRS):
            try:
                _forget_pid(directory, pid)
            except Exception:
                pass
    _TRACKED_DIRS.clear()
    _remove_tree(scratch)


def _restart_word(project_dir):
    """One clean restart after a COM failure.  Worker thread only."""
    _quit_word()
    return _start_word(project_dir)


# ---------------------------------------------------------------------------
# docx -> pdf, on the resident instance
# ---------------------------------------------------------------------------
def _export_pdf_once(docx_abs, pdf_abs):
    """Open, export, close.  Worker thread, instance already up."""
    doc = None
    try:
        doc = _APP.Documents.Open(
            os.path.abspath(docx_abs),
            ConfirmConversions=False, ReadOnly=True, AddToRecentFiles=False,
            Visible=False)
        # Fields are deliberately NOT refreshed here. This document holds one
        # section, so recomputing the caption counters would renumber it from 1.
        # The ones that Word would recalculate on its own during pagination have
        # already been frozen to the numbers they carry in the complete report --
        # see _freeze_number_fields, which is what makes the page image agree with
        # the exported document.
        doc.ExportAsFixedFormat(os.path.abspath(pdf_abs), _WD_EXPORT_FORMAT_PDF)
    finally:
        if doc is not None:
            try:
                doc.Close(False)    # never touch doc after this
            except Exception:
                pass


def _convert_on_worker(project_dir, docx_abs, pdf_abs):
    """Ensure an instance, export, and retry once through a fresh one."""
    global _RENDERS
    if _APP is None:
        _start_word(project_dir)
    else:
        _track(project_dir)         # this report may not carry our record yet
    heartbeat()
    try:
        _export_pdf_once(docx_abs, pdf_abs)
    except LivePreviewUnavailable:
        raise
    except Exception as first:
        # One automatic restart: a resident instance can be lost to a crash or an
        # RPC disconnect. If the second attempt fails too, the error is real and
        # the caller sees it.
        try:
            _restart_word(project_dir)
            _export_pdf_once(docx_abs, pdf_abs)
        except LivePreviewUnavailable:
            raise
        except Exception as second:
            raise RuntimeError(
                "Word could not convert the section to PDF (first attempt: %s; "
                "after restarting Word: %s)" % (first, second))
    _RENDERS += 1
    heartbeat()
    return pdf_abs


# ---------------------------------------------------------------------------
# pdf -> png
# ---------------------------------------------------------------------------
def _rasterise(pdf_path, dpi=None):
    """One PNG per page, base64 encoded, with its pixel size."""
    import fitz
    zoom = float(dpi or RENDER_DPI) / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pages = []
    doc = fitz.open(pdf_path)
    try:
        for page in doc:
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            pages.append({
                "png_b64": base64.b64encode(pix.tobytes("png")).decode("ascii"),
                "w": int(pix.width),
                "h": int(pix.height),
            })
    finally:
        doc.close()
    return pages


# ---------------------------------------------------------------------------
# Freezing the numbering fields of a one-section document
# ---------------------------------------------------------------------------
#: Field instructions whose result is frozen before a SECTION is handed to Word.
_FROZEN_FIELDS = ("SEQ ", "STYLEREF ", "REF ")


def _field_runs(para, qn):
    """Group a paragraph's runs into complete Word fields.

    A field is spelled out as a run sequence: fldChar(begin), instrText runs,
    fldChar(separate), the cached result runs, fldChar(end).  Returns the list of
    OUTERMOST fields, each ``{"begin", "pre", "sep", "result", "end"}`` where
    ``pre`` holds the instruction runs.  Nested fields are folded into their
    parent's run list and left alone.
    """
    stack, fields = [], []
    for run in list(para):
        if run.tag != qn("w:r"):
            continue
        marker = run.find(qn("w:fldChar"))
        kind = marker.get(qn("w:fldCharType")) if marker is not None else None
        if kind == "begin":
            stack.append({"begin": run, "pre": [], "sep": None,
                          "result": [], "end": None})
            continue
        if not stack:
            continue                    # ordinary text outside any field
        current = stack[-1]
        if kind == "separate":
            current["sep"] = run
        elif kind == "end":
            current["end"] = run
            stack.pop()
            (fields if not stack else stack[-1]["result"]).append(current)
        else:
            (current["result"] if current["sep"] is not None
             else current["pre"]).append(run)
    return [f for f in fields if isinstance(f, dict)]


def _freeze_number_fields(docx_path):
    """Turn the caption / cross-reference number fields into plain text.

    Why this exists: a one-section document is a FRAGMENT.  Its captions carry
    ``SEQ Figure \\* ARABIC \\s 1`` fields, and the renderer has already written
    the number the figure has in the complete report as each field's cached
    result.  Word, however, recalculates SEQ (and STYLEREF) while it paginates for
    the PDF, and inside a fragment that count restarts -- so a section that really
    holds figures 5-32..5-34 would be shown as 5-1..5-3, and the page images would
    disagree with the exported document.

    Replacing each such field with the result the renderer computed makes the page
    image show the report's real numbers.  Only the main document part is touched
    and only these three instructions, so the page numbers in the footer stay live
    fields and keep counting correctly.  Nothing here touches the exported
    document: this rewrites the throwaway copy in the preview's temp folder.

    Returns the number of fields frozen.
    """
    from docx import Document
    from docx.oxml.ns import qn

    doc = Document(docx_path)
    frozen = 0
    for para in doc.element.body.iter(qn("w:p")):
        for field in _field_runs(para, qn):
            instruction = "".join(
                (node.text or "")
                for run in field["pre"] if not isinstance(run, dict)
                for node in run.iter(qn("w:instrText")))
            if not any(tok in instruction for tok in _FROZEN_FIELDS):
                continue
            result_runs = [r for r in field["result"] if not isinstance(r, dict)]
            if field["sep"] is None or not result_runs:
                continue        # no cached result: removing it would lose the text
            for element in ([field["begin"], field["sep"], field["end"]]
                            + [r for r in field["pre"] if not isinstance(r, dict)]):
                if element is not None and element.getparent() is para:
                    para.remove(element)
            frozen += 1
    if frozen:
        doc.save(docx_path)
    return frozen


# ---------------------------------------------------------------------------
# One section as a .docx, via the engine
# ---------------------------------------------------------------------------
def _load_project(project_dir):
    path = os.path.join(project_dir, "project.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _resolve_cfg(engine, project, project_dir, cfg):
    """Use the config the caller resolved, or resolve one the same way it would.

    The server always passes a config, so this fallback exists for the command
    line and for tests. It first asks the renderer (environment variable, or a
    config file sitting beside the report folder); failing that it looks the
    report's template id up in the template library, searching upward from the
    report folder because the reports root is a few levels above it.
    """
    if cfg:
        return cfg
    try:
        return engine._load_config(
            engine._resolve_config_path(project, project_dir, None))
    except Exception as unresolved:
        tid = (project or {}).get("template")
        if not tid:
            raise
        try:
            import templates_store
        except ImportError:
            raise unresolved
        folder = os.path.abspath(project_dir)
        for _ in range(4):
            parent = os.path.dirname(folder)
            if parent == folder:
                break
            folder = parent
            found = templates_store.template_config_path(folder, tid)
            if found:
                return engine._load_config(found)
        raise


def _section_render_call(engine, project, cfg, project_dir, out_path, node_id):
    """Ask the engine for a one-section document, tolerating its two shapes.

    Section-only rendering is exposed either as its own entry point or as a
    keyword on the full render. Both are matched by PARAMETER NAME so this module
    does not depend on argument order. Returns (result, scope), where scope is
    "section" or -- when neither shape is present -- "document", so the caller can
    say what it actually produced instead of quietly claiming a section.
    """
    import inspect

    fn = getattr(engine, "render_section_docx", None)
    if callable(fn):
        names = list(inspect.signature(fn).parameters)
        for key in ("node_id", "section_only", "node", "section", "section_id"):
            if key in names:
                return fn(project, cfg, project_dir, out_path,
                          **{key: node_id}), "section"
        return fn(project, cfg, project_dir, out_path, node_id), "section"

    render = engine.render_report
    names = list(inspect.signature(render).parameters)
    for key in ("section_only", "node_id", "section"):
        if key in names:
            return render(project, cfg, project_dir, out_path,
                          **{key: node_id}), "section"
    # No section-only support in this build of the renderer: produce the whole
    # document rather than nothing, and label the result honestly.
    return render(project, cfg, project_dir, out_path), "document"


def _render_docx(project_dir, cfg, node_id, out_path):
    import engine
    project = _load_project(project_dir)
    cfg = _resolve_cfg(engine, project, project_dir, cfg)
    result, scope = _section_render_call(
        engine, project, cfg, project_dir, out_path, node_id)
    path = engine._result_out_path(result) or out_path
    warnings = result.get("warnings", []) if isinstance(result, dict) else []
    frozen = 0
    if scope == "section":
        # Only a fragment needs this. A whole-document render must keep its live
        # fields, because there Word recalculates them to the right answer.
        try:
            frozen = _freeze_number_fields(path)
        except Exception as exc:
            warnings = list(warnings) + [{
                "type": "block_error", "level": "warn",
                "detail": "caption numbers left as live fields (%s: %s)"
                          % (type(exc).__name__, str(exc)[:120]),
                "location": "page images"}]
    return path, scope, warnings, frozen


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def render_section(project_dir, cfg, node_id):
    """Render one section of a report to page images.

    Returns ``{"pages": [{"png_b64", "w", "h"}, ...], "ms": int, ...}``; the extra
    keys (per-stage timings, dpi, scope, warnings) are additive and safe to ignore.

    Raises ``LivePreviewUnavailable`` when this machine cannot do it at all -- no
    Word, no pywin32, no PyMuPDF -- so the caller can disable the control and fall
    back to the approximate layout instead of showing a broken screen.
    """
    reason = _capability_error()
    if reason:
        raise LivePreviewUnavailable(reason)
    if not project_dir or not os.path.isdir(project_dir):
        raise ValueError("no such report folder: %s" % project_dir)
    if not node_id:
        raise ValueError("missing 'node': which section should be rendered?")

    started = time.time()
    with _RENDER_LOCK:                      # one instance, one render at a time
        # A render in flight counts as use: building the .docx can take a moment,
        # and the idle watchdog must not reclaim the instance we are about to use.
        heartbeat()
        target = os.path.abspath(project_dir)
        if target not in _TRACKED_DIRS:
            # First time this server touches this report: clear out anything a
            # previous run of the server left behind. Only ids recorded in this
            # report's pid file are eligible, and only while they still match.
            sweep_stale(target, keep_pid=_APP_PID)

        scratch = tempfile.mkdtemp(prefix="sect_", dir=preview_dir(target))
        try:
            docx_path = os.path.join(scratch, "section.docx")
            t0 = time.time()
            docx_path, scope, warnings, frozen = _render_docx(
                target, cfg, node_id, docx_path)
            t1 = time.time()

            pdf_path = os.path.splitext(docx_path)[0] + ".pdf"
            _submit(lambda: _convert_on_worker(target, docx_path, pdf_path))
            t2 = time.time()

            pages = _rasterise(pdf_path)
            t3 = time.time()
        finally:
            _remove_tree(scratch)

    return {
        "pages": pages,
        "ms": int(round((time.time() - started) * 1000)),
        "docx_ms": int(round((t1 - t0) * 1000)),
        "word_ms": int(round((t2 - t1) * 1000)),
        "png_ms": int(round((t3 - t2) * 1000)),
        "dpi": int(RENDER_DPI),
        "node": node_id,
        "scope": scope,
        "frozen_fields": frozen,
        "warnings": warnings,
    }


def shutdown():
    """Quit our Word instance and clean up.  Idempotent; safe at process exit.

    Prefers the worker thread, because that is the apartment the COM object lives
    in.  If the worker is already gone -- interpreter teardown, say -- the pid and
    creation time recorded at start are enough to finish the job without it.
    """
    global _WORKER
    with _WORKER_LOCK:
        worker = _WORKER
        _WORKER = None
    if worker is not None and worker.is_alive():
        _QUEUE.put(None)                    # sentinel: end the loop, quit Word
        worker.join(timeout=QUIT_GRACE + 10.0)
        if _APP_PID is None:
            return
    # Fallback: the worker never ran, died, or did not finish in time.
    pid, created, scratch = _APP_PID, _APP_CREATED, _APP_TEMPDIR
    if pid is not None:
        _terminate_recorded(pid, created)
        for directory in list(_TRACKED_DIRS):
            try:
                _forget_pid(directory, pid)
            except Exception:
                pass
    _TRACKED_DIRS.clear()
    _remove_tree(scratch)


def status():
    """A snapshot of the resident instance, for a status panel or a test."""
    capability = _capability_error()
    return {
        "alive": _APP is not None,
        "pid": _APP_PID,
        "started": _APP_STARTED,
        "renders": _RENDERS,
        "available": capability is None,
        "reason": capability or _LAST_REASON,
        "last_used": _LAST_USED or None,
        "idle_timeout": IDLE_TIMEOUT,
        "dpi": int(RENDER_DPI),
        "tracked_dirs": sorted(_TRACKED_DIRS),
    }


atexit.register(shutdown)


# ---------------------------------------------------------------------------
# CLI: render one section and report timings (handy as a smoke check)
# ---------------------------------------------------------------------------
def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(
        description="Render one section of a report to page images.")
    ap.add_argument("project_dir")
    ap.add_argument("node")
    ap.add_argument("--config", default=None)
    ap.add_argument("--out", default=None, help="folder to save the PNG pages in")
    ap.add_argument("--repeat", type=int, default=1,
                    help="render this many times to show the warm timings")
    args = ap.parse_args(argv)

    cfg = None
    if args.config:
        import engine
        cfg = engine._load_config(args.config)

    result = None
    try:
        for _ in range(max(1, args.repeat)):
            result = render_section(args.project_dir, cfg, args.node)
            sys.stdout.write(
                "pages=%d scope=%s total=%dms (docx %dms, word %dms, png %dms)\n"
                % (len(result["pages"]), result["scope"], result["ms"],
                   result["docx_ms"], result["word_ms"], result["png_ms"]))
    except LivePreviewUnavailable as exc:
        sys.stderr.write("unavailable: %s\n" % exc.reason)
        return 2

    if args.out and result:
        os.makedirs(args.out, exist_ok=True)
        for i, page in enumerate(result["pages"], 1):
            path = os.path.join(args.out, "page%02d.png" % i)
            with open(path, "wb") as fh:
                fh.write(base64.b64decode(page["png_b64"]))
            sys.stdout.write("  %s  %dx%d\n" % (path, page["w"], page["h"]))
    sys.stdout.write("status=%s\n" % json.dumps(status()))
    shutdown()
    sys.stdout.write("after shutdown=%s\n" % json.dumps(status()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
