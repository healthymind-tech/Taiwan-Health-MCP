import datetime
import sys


def log_info(message: str):
    """
    Writes info messages to standard error (stderr).
    This avoids interfering with MCP's standard output (stdout) communication.
    """
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[INFO][{timestamp}] {message}\n")


def log_error(message: str):
    """
    Writes error messages to standard error (stderr).
    """
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[ERROR][{timestamp}] {message}\n")
