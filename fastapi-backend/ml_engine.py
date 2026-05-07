import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import RandomForestClassifier
import pickle
from pathlib import Path

# This is a simplified ML model for Job Authenticity Detection
# In a real scenario, this would be trained on the EMSI or Kaggle Fake Jobs dataset

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "job_model.pkl"
VECTORIZER_PATH = BASE_DIR / "vectorizer.pkl"

def train_mock_model():
    """Simulates training a model on a job dataset."""
    data = {
        'text': [
            "Senior Software Engineer at Google with great benefits",
            "Work from home earn 5000 dollars a day no experience needed",
            "Urgent hiring for data entry operator high commission",
            "Frontend Developer with 5 years experience in React and Tailwind",
            "Administrative assistant needed for established law firm",
            "Easy money fast cash click here to apply now"
        ],
        'label': [1, 0, 0, 1, 1, 0] # 1 = Real, 0 = Fake
    }
    df = pd.DataFrame(data)
    
    vectorizer = TfidfVectorizer(stop_words='english')
    X = vectorizer.fit_transform(df['text'])
    y = df['label']
    
    model = RandomForestClassifier(n_estimators=100)
    model.fit(X, y)
    
    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(model, f)
    with open(VECTORIZER_PATH, 'wb') as f:
        pickle.dump(vectorizer, f)
    print("AI Model Trained & Saved.")

def predict_authenticity(job_description: str) -> float:
    """Predicts the probability of a job being real."""
    if not MODEL_PATH.exists() or not VECTORIZER_PATH.exists():
        train_mock_model()
        
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    with open(VECTORIZER_PATH, 'rb') as f:
        vectorizer = pickle.load(f)
        
    X = vectorizer.transform([job_description])
    # Return probability of being 'Real' (label 1)
    prob = model.predict_proba(X)[0][1]
    return round(float(prob) * 100, 2)

if __name__ == "__main__":
    train_mock_model()

def predict_ghost_job_likelihood(job_data: dict, company_history: dict) -> dict:
    """
    Expert logic for Ghost Job Prediction.
    Calculates likelihood based on description patterns and historical sink data.
    """
    base_likelihood = company_history.get("avg_sink_score", 30)
    text = job_data.get("description", "").lower()
    
    # Pattern matching for 'Evergreen' or 'Ghost' indicators
    ghost_patterns = ["always hiring", "talent pipeline", "potential future open", "future consideration"]
    if any(p in text for p in ghost_patterns):
        base_likelihood += 45
        
    likelihood = min(100, max(0, base_likelihood))
    return {
        "ghost_likelihood": round(likelihood, 1),
        "is_ghost_listing": likelihood > 75,
        "recommendation": "Avoid" if likelihood > 75 else ("Caution" if likelihood > 40 else "Safe")
    }
