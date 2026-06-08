"""Admin console — auth/session re-exports.

The admin UI is now the React SPA in ``admin-ui/`` (served by ``server.py`` from
``admin-ui/dist``). Only the server-rendered login page, session helpers, and
the overview API payload dataclass remain here; they live in
``admin_html_shell``.
"""

# ruff: noqa: F401
from admin_html_shell import (
    AdminOverviewPayload,
    SESSION_COOKIE_NAME,
    build_admin_login_html,
    build_admin_session_cookie,
    build_admin_session_token,
    clear_admin_session_cookie,
    parse_admin_session_token,
    verify_admin_password,
)
