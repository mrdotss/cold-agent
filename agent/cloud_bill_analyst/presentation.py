"""Money-formatting helpers matching the presentation rules in the system prompt.

  USD -> "$1,234.56"     (comma thousands, 2 decimals)
  IDR -> "Rp 12.345.678" (dot thousands, no decimals)
  other -> "<CODE> 1,234.56"
"""
from __future__ import annotations


def format_money(amount: float, currency: str = "USD") -> str:
    cur = (currency or "USD").upper()
    if cur == "USD":
        return f"${amount:,.2f}"
    if cur == "IDR":
        return "Rp " + f"{round(amount):,}".replace(",", ".")
    return f"{cur} {amount:,.2f}"


def format_dual(usd: float, display_amount: float, display_currency: str) -> str:
    """Display-currency amount with the original USD alongside, per the prompt."""
    return f"{format_money(display_amount, display_currency)} ({format_money(usd, 'USD')})"
