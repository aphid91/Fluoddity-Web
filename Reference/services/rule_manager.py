import numpy as np

# Maximum number of rules to keep in history
MAX_HISTORY_SIZE = 200


class RuleManager:
    """Owns rule_history and all rule operations. Stores (rule, seed) tuples."""

    def __init__(self):
        self.rule_history: list[tuple[np.ndarray, float]] = []

    def push_rule(self, rule: np.ndarray, seed: float) -> None:
        """Add a new rule with its seed to history, trimming oldest if exceeds limit."""
        self.rule_history.append((rule, seed))
        self._trim_history()

    def _trim_history(self) -> None:
        """Remove oldest rules if history exceeds MAX_HISTORY_SIZE."""
        while len(self.rule_history) > MAX_HISTORY_SIZE:
            self.rule_history.pop(0)

    def push_zero_rule(self, seed: float) -> np.ndarray:
        """Push a zero rule (no target) with seed to history. Returns the zero rule."""
        zero_rule = np.zeros((10, 8), dtype=np.float32)
        self.push_rule(zero_rule, seed)
        return zero_rule

    def pop_rule(self) -> tuple[np.ndarray | None, float | None]:
        """Remove current state and return the previous (rule, seed) for restoration.

        Stack top represents current state. Pop removes it and returns the
        previous state (new top after removal) for restoration.
        Returns (None, None) if no previous state exists.
        """
        if len(self.rule_history) > 1:
            self.rule_history.pop()  # Remove current
            return self.rule_history[-1]  # Return previous (new top)
        elif len(self.rule_history) == 1:
            self.rule_history = []
            return (None, None)  # No previous state
        return (None, None)

    def get_current_rule(self) -> np.ndarray | None:
        """Get current rule without modifying history."""
        return self.rule_history[-1][0] if self.rule_history else None

    def get_current_seed(self) -> float | None:
        """Get current seed without modifying history."""
        return self.rule_history[-1][1] if self.rule_history else None

    def clear(self) -> None:
        """Clear all rule history."""
        self.rule_history = []

    def has_rules(self) -> bool:
        """Check if there are any rules in history."""
        return len(self.rule_history) > 0
    def length(self) -> int:
        return len(self.rule_history)
