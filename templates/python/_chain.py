

class _Todo(str):
    """Default of a parameter tabcap could not derive from the recording (see the TODO comment at the function)."""


TODO = _Todo("TODO")


def _need(mark: str, **values: Any) -> None:
    """Raise NotImplementedError naming every parameter still at its TODO default."""
    missing = [k for k, v in values.items() if isinstance(v, _Todo)]
    if missing:
        raise NotImplementedError(f"{mark} ({', '.join(missing)} not given)")
