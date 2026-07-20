"""Deterministic money-formatting golden tests."""
from cloud_bill_analyst.presentation import format_dual, format_money


def test_usd():
    assert format_money(1234.56, "USD") == "$1,234.56"
    assert format_money(0, "USD") == "$0.00"
    assert format_money(1000000, "USD") == "$1,000,000.00"


def test_idr():
    assert format_money(12345678, "IDR") == "Rp 12.345.678"
    assert format_money(1234567.89, "IDR") == "Rp 1.234.568"  # rounded, dot thousands
    assert format_money(1000, "IDR") == "Rp 1.000"


def test_other_currency():
    assert format_money(1000000, "EUR") == "EUR 1,000,000.00"


def test_dual():
    assert format_dual(1234.56, 22170000, "IDR") == "Rp 22.170.000 ($1,234.56)"
