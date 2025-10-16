"""The generation orchestrator (LLD §6): plan, then compose, verify and repair one block at a time,
falling back to the block's template; only verified blocks are committed. `Orchestrator.run` is
what `tutor_api.jobs.runner` calls; it touches the job and the project only through `JobContext`."""

from .job import Orchestrator

__all__ = ["Orchestrator"]
