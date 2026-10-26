from .index import httpResponse


def loader():
    return httpResponse({"ok": True})
