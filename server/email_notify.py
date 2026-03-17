"""Lightweight email notification for admin access events."""

import logging
import os
import smtplib
from email.mime.text import MIMEText
from datetime import datetime

logger = logging.getLogger(__name__)


def send_admin_login_alert():
    """Send email alert on admin login. Fire-and-forget — failures are logged silently."""
    recipient = os.environ.get("ADMIN_ALERT_EMAIL")
    smtp_host = os.environ.get("SMTP_HOST")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER")
    smtp_password = os.environ.get("SMTP_PASSWORD")

    if not all([recipient, smtp_host, smtp_user, smtp_password]):
        return

    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        msg = MIMEText(
            f"Admin login detected at {timestamp}.\n\n"
            "If this wasn't you, check your admin credentials immediately."
        )
        msg["Subject"] = "RoomDesigner: Admin Login Alert"
        msg["From"] = smtp_user
        msg["To"] = recipient

        with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
            server.starttls()
            server.login(smtp_user, smtp_password)
            server.send_message(msg)

        logger.info(f"Admin login alert sent to {recipient}")
    except Exception as e:
        logger.warning(f"Failed to send admin login alert: {e}")
