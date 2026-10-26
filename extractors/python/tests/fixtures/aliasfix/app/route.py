from . import index


def loader():
    return index.httpResponse({"ok": True})
