"""Entry point.

    python main.py                  the app, as it has always been
    python main.py --api-port 8765  the same app, plus the piloting API

THE FLAG ADDS, IT DOES NOT CHANGE. Without it nothing about the app differs:
the API's state exists on the Orchestrator either way, and the frame loop's two
extra lines are no-ops while `pilot` is None. That is deliberate -- a research
transport should not be able to alter the thing it is there to observe.

See docs/API.md.
"""

import argparse

from orchestrator import Orchestrator


def main():
    parser = argparse.ArgumentParser(description="Fluoddity-Core")
    parser.add_argument(
        '--api-port', type=int, default=None, metavar='PORT',
        help="serve the piloting API on 127.0.0.1:PORT (off by default)")
    args = parser.parse_args()

    app = Orchestrator()
    if args.api_port is not None:
        # After construction: the server can be handed work the moment it
        # starts, so everything it might reach has to exist first.
        app.start_api(args.api_port)
    app.run()


if __name__ == "__main__":
    main()
