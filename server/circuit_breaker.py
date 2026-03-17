"""Circuit breaker pattern for external service calls."""

import logging
import time

logger = logging.getLogger(__name__)


class CircuitBreaker:
    """
    Circuit breaker: after N consecutive failures, fail fast instead of waiting for timeouts.

    States:
    - CLOSED: normal operation, requests pass through
    - OPEN: too many failures, requests fail immediately
    - HALF_OPEN: recovery probe — allow one request through to test
    """

    def __init__(self, service_name: str, failure_threshold: int = 3, recovery_timeout: float = 60.0):
        self.service_name = service_name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.state = "CLOSED"
        self.last_failure_time = 0.0

    def can_execute(self) -> bool:
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            if time.time() - self.last_failure_time >= self.recovery_timeout:
                self.state = "HALF_OPEN"
                logger.info(f"Circuit breaker [{self.service_name}] HALF_OPEN — allowing probe request")
                return True
            return False
        return True  # HALF_OPEN: allow one attempt

    def record_success(self):
        if self.state != "CLOSED":
            logger.info(f"Circuit breaker [{self.service_name}] CLOSED — service recovered")
        self.failure_count = 0
        self.state = "CLOSED"

    def record_failure(self):
        self.failure_count += 1
        self.last_failure_time = time.time()
        if self.failure_count >= self.failure_threshold:
            if self.state != "OPEN":
                logger.warning(f"Circuit breaker [{self.service_name}] OPEN — {self.failure_count} consecutive failures")
            self.state = "OPEN"

    def get_status(self) -> dict:
        return {
            "service": self.service_name,
            "state": self.state,
            "failureCount": self.failure_count,
            "failureThreshold": self.failure_threshold,
            "recoveryTimeout": self.recovery_timeout,
        }


# Per-service breaker instances
moge_breaker = CircuitBreaker("moge2", failure_threshold=3, recovery_timeout=120.0)
gemini_breaker = CircuitBreaker("gemini", failure_threshold=3, recovery_timeout=60.0)
trellis_breaker = CircuitBreaker("trellis2", failure_threshold=3, recovery_timeout=120.0)
sam3_breaker = CircuitBreaker("sam3", failure_threshold=3, recovery_timeout=120.0)
