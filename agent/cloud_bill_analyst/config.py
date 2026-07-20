"""Central configuration from environment variables.

Mirrors the harness runtime's env contract (AWS_MEMORY_ARN, AWS_REGION,
AWS_STAGE, AWS_TRUNCATION_MESSAGES_COUNT, AWS_TRUNCATION_STRATEGY) and adds a
pluggable orchestrator model via MODEL_ID.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


def _int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def memory_id_from_arn(arn: Optional[str]) -> Optional[str]:
    if not arn:
        return None
    # arn:aws:bedrock-agentcore:<region>:<acct>:memory/<id>
    return arn.rsplit("/", 1)[-1] if "/" in arn else arn


@dataclass(frozen=True)
class Config:
    region: str
    model_id: str
    memory_id: Optional[str]
    memory_arn: Optional[str]
    conversation_window: int
    truncation_strategy: str
    temperature: float
    max_tokens: int
    stage: str
    default_report_bucket: Optional[str]
    default_report_prefix: str
    default_display_currency: str
    default_timezone: str

    @staticmethod
    def from_env() -> "Config":
        memory_arn = os.environ.get("AWS_MEMORY_ARN") or None
        memory_id = os.environ.get("AWS_MEMORY_ID") or memory_id_from_arn(memory_arn)
        return Config(
            region=os.environ.get("AWS_REGION") or "us-east-1",
            model_id=os.environ.get("MODEL_ID") or "moonshotai.kimi-k2.5",
            memory_id=memory_id,
            memory_arn=memory_arn,
            conversation_window=_int("AWS_TRUNCATION_MESSAGES_COUNT", 150),
            truncation_strategy=os.environ.get("AWS_TRUNCATION_STRATEGY") or "sliding_window",
            temperature=_float("MODEL_TEMPERATURE", 0.2),
            max_tokens=_int("MODEL_MAX_TOKENS", 4096),
            stage=os.environ.get("AWS_STAGE") or "prod",
            default_report_bucket=os.environ.get("REPORT_BUCKET") or None,
            default_report_prefix=os.environ.get("REPORT_PREFIX") or "reports/",
            default_display_currency=os.environ.get("DEFAULT_DISPLAY_CURRENCY") or "IDR",
            default_timezone=os.environ.get("DEFAULT_TIMEZONE") or "Asia/Jakarta",
        )
