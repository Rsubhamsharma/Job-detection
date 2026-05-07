import math
from typing import Dict, TypedDict, Optional

def calculate_energy_sink_score(effort_metrics: dict, response_signals: list, score_status: str = "scored", energy_sink_score: Optional[float] = None) -> dict:
    """ 
    Exact Sink Score Formula (AESD System):
    Score = (Weighted Effort / Max(1, Meaningful Responses)) * 10

    Rules:
    - scoreStatus = not_enough_effort_data => recommendation must be Tracking
    - energySinkScore null => recommendation must be Tracking
    - Do not show Avoid or Apply confidently until scoreStatus = scored
    - Apply click increases effort, but does not automatically mean Avoid
    - Avoid only when scoreStatus = scored and energySinkScore >= 70
    """
    # Weights for Effort
    W_TIME = 0.4  # Minutes spent
    W_FIELDS = 0.3  # Number of manual fields
    W_REDIRECTIONS = 0.2  # ATS redirect count
    W_UPLOADS = 0.1  # Resume/Cover Letter uploads

    # Calculate Raw Effort
    raw_effort = (
        (effort_metrics.get("time_spent", 0) * W_TIME) +
        (effort_metrics.get("fields_filled", 0) * W_FIELDS) +
        (effort_metrics.get("ats_redirects", 0) * W_REDIRECTIONS) +
        (effort_metrics.get("uploads", 0) * W_UPLOADS)
    )

    # Calculate Response Value
    # Responses reduce the sink score because they represent outcome
    response_value = 0
    for sig in response_signals:
        if sig["type"] == "INTERVIEW":
            response_value += 10
        if sig["type"] == "REJECTION":
            response_value += 2
        if sig["type"] == "ACK":
            response_value += 0.5

    # Formula: High effort + Zero response = High Sink
    # Normalizing to 0-100
    if energy_sink_score is not None:
        sink_score = energy_sink_score
    else:
        sink_score = min(100, (raw_effort / max(1, response_value)) * 10)

    # Determine recommendation based on rules
    if score_status in ["not_enough_effort_data", "not_enough_data"]:
        recommendation = "Tracking"
    elif energy_sink_score is None:
        recommendation = "Tracking"
    else:
        # Only show Avoid/Apply confidently when scoreStatus = scored
        if score_status == "scored":
            if sink_score >= 70:
                recommendation = "Avoid"
            elif sink_score >= 40:
                recommendation = "Apply cautiously"
            else:
                recommendation = "Apply confidently"
        else:
            # For other statuses (tracking_response_pending, response_pending), keep as Tracking
            recommendation = "Tracking"

    result = {
        "score": round(sink_score, 1) if sink_score is not None else None,
        "raw_effort": round(raw_effort, 1),
        "response_value": response_value,
        "recommendation": recommendation,
        "scoreStatus": score_status,
    }
    
    if sink_score is not None:
        result["alert"] = sink_score > 80
    else:
        result["alert"] = False
        
    return result
