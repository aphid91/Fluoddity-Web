"""The piloting API: drive Fluoddity from another program.

An optional transport, off unless `--api-port` is given. The app must behave
identically without it -- see main.py.

    api/protocol.py   the socket-thread -> frame-loop handoff
    api/schedule.py   commands keyed to app frames (pure; no app access)
    api/server.py     HTTP routes
    api/runner.py     the frame loop's half: draining and schedule execution

Nothing here touches GL or holds simulation state. The handlers it ultimately
invokes live in orchestrator/api_commands.py, beside the app's other commands.

See docs/API.md for the wire format and docs/CLIP_INTEGRATION.md for what this
was built for.
"""

from .protocol import PilotHost, Request, CommandError
from .runner import ScheduleRunner, CommandQueue
from .server import PilotServer, API_COMMANDS

__all__ = ['PilotHost', 'Request', 'CommandError', 'ScheduleRunner',
           'CommandQueue', 'PilotServer', 'API_COMMANDS']
