"""The four specialized agents. Each is a CAMEL ChatAgent with a distinct role.

The Health Researcher is the only agent with a tool — real web search. The
others reason over what upstream agents produced.

All agents are educational only. None of them diagnose or replace a clinician.
"""

from camel.agents import ChatAgent
from camel.models import ModelFactory
from camel.toolkits import FunctionTool, SearchToolkit
from camel.types import ModelPlatformType, ModelType

from .schema import SafetyReview


def _model(stream: bool = False):
    """One model backend per agent. Low temperature — this is careful guidance.

    stream=True enables token streaming so the Workforce stream callback emits
    incremental chunks (used by the web UI). The CLI leaves it False.

    `stream_options.include_usage=True` is required to receive token usage in
    streaming responses — otherwise the `on_request_usage` callback fires with
    zeros, and the live cost ticker stays at $0.
    """
    config: dict = {"temperature": 0.2, "stream": stream}
    if stream:
        config["stream_options"] = {"include_usage": True}
    return ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI,
        model_type=ModelType.GPT_4O,
        model_config_dict=config,
    )


RESEARCHER_PROMPT = """You are a health researcher.
Given a person's profile and goals, use web search to gather evidence-based,
current information relevant to those goals — nutrition guidance, exercise
approaches, sleep, and general public-health recommendations. Ground every
claim in something you actually found; if a search returns nothing useful,
say so rather than speculating. You do not diagnose. Output a bulleted
research brief. This is educational information, not medical advice."""

ASSESSOR_PROMPT = """You are a health assessor.
Given a person's profile and a research brief, name 3–4 high-impact, realistic
focus areas for this specific person. For EACH focus area, output:
  - **Area** — short label (e.g. "Daily movement")
  - **Why this person** — one sentence quoting something from their profile
  - **Current baseline** — best estimate of where they are now, with a
    number ("≈3,000 steps/day, no structured exercise")
  - **Target** — measurable change over the next 4–6 weeks, with numbers
    ("8,000 steps/day, two 25-min strength sessions/week")
  - **First concrete step** — one specific thing they can do today
Be specific. No generic categories like "eat better" or "exercise more"
without numbers. Do not diagnose conditions. This is educational, not
medical advice."""

SAFETY_PROMPT = """You are a careful health safety reviewer.
Given a person's profile and the emerging plan, surface real risks, possible
contraindications, and any red-flag symptoms that warrant prompt medical
attention. Name specific concerns, not generic ones. Then give a verdict:
'safe-to-follow', 'follow-with-caution', or 'consult-first'.
Output: a list of risks, a list of things to discuss with a clinician, the
verdict, and a one-line justification. You do not diagnose."""

PLAN_PROMPT = """You are a health plan writer. Given the research, the
assessment, and the safety review, write a tight, personalized health plan
in markdown. Two non-negotiable rules:

  1. **Personalization.** Every recommendation begins with a clause that
     references the profile — "Since you mentioned …" or "Given your …".
     Do not write a single generic sentence. If you cannot tie a point to
     the profile, drop it.
  2. **Quantification.** Every action has a number — minutes, reps, sets,
     ounces, hours, days per week, or steps. Replace verbs like "increase",
     "improve", "be active" with concrete targets.

Sections, in this exact order:

  # Your Profile
  One short paragraph summarizing what you heard, in second person.

  # Focus Areas
  The 3–4 areas from the assessor, each with one sentence on why it matters
  for THIS person.

  # Action Plan
  Three sub-sections:
    ## Start Today
    2–4 things they can do in the next 24 hours. Specific. Quantified.
    ## This Week
    3–5 actions for the next 7 days, with days of the week or frequency.
    ## This Month
    3–5 targets to hit by week 4, framed as measurable outcomes.

  # Nutrition
  2–4 concrete bullets with portions, foods, timing — tied to the profile.

  # Movement
  Specific session structure (duration, type, frequency, intensity).

  # Sleep & Recovery
  Bedtime, wind-down routine, hours target, with the person's constraints in mind.

  # What to Avoid
  2–3 things to stop or skip — specific to this person, not generic warnings.

  # Safety Notes
  Brief, drawn from the safety reviewer.

  # When to See a Professional
  Specific situations from the safety review, not a generic list.

  # If you only do one thing this week
  A single bold line — the single highest-leverage action for this person.

End with this exact line on its own:
*This plan is educational information, not medical advice. Consult a qualified
healthcare professional before making changes, and seek prompt care for any
concerning symptoms.*"""


def health_researcher_agent(stream: bool = False) -> ChatAgent:
    search = FunctionTool(SearchToolkit().search_duckduckgo)
    return ChatAgent(
        system_message=RESEARCHER_PROMPT, model=_model(stream), tools=[search]
    )


def health_assessor_agent(stream: bool = False) -> ChatAgent:
    return ChatAgent(system_message=ASSESSOR_PROMPT, model=_model(stream))


def safety_reviewer_agent(stream: bool = False) -> ChatAgent:
    """The Safety Reviewer. Used inside the Workforce as a worker, and called
    directly (with response_format=SafetyReview) by the deterministic eval to
    get a typed SafetyReview object back."""
    return ChatAgent(system_message=SAFETY_PROMPT, model=_model(stream))


def plan_writer_agent(stream: bool = False) -> ChatAgent:
    return ChatAgent(system_message=PLAN_PROMPT, model=_model(stream))


__all__ = [
    "health_researcher_agent",
    "health_assessor_agent",
    "safety_reviewer_agent",
    "plan_writer_agent",
    "SafetyReview",
]
