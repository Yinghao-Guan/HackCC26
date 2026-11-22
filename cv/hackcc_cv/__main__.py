"""Start the CV service:  uv run python -m hackcc_cv [--fake] [--no-camera] [--camera N]"""

from __future__ import annotations

import logging
import sys

import uvicorn

from .config import ConfigError, load_config
from .server import create_app

log = logging.getLogger("hackcc_cv")


def main() -> int:  # pragma: no cover - starts a real server
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        config = load_config(argv=sys.argv[1:])
    except ConfigError as error:
        log.error("%s", error)
        return 2
    log.info("Debug page: http://%s:%d/debug", config.host, config.port)
    # Don't wait forever for open preview streams when stopping with Ctrl+C.
    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        log_level="info",
        timeout_graceful_shutdown=2,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
