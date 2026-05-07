import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import random
from dotenv import load_dotenv

load_dotenv()

# Config
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
SMTP_USER = os.getenv("SMTP_USER", "") # your_email@gmail.com
SMTP_PASS = os.getenv("SMTP_PASS", "") # your_app_password

def send_otp_email(receiver_email, otp):
    """
    Sends an OTP to the specified email.
    If SMTP_USER/PASS are missing, it logs to console only.
    """
    subject = f"Your JobZoid Verification Code: {otp}"
    body = f"""
    <html>
        <body style="font-family: Arial, sans-serif; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #4f46e5;">JobZoid Verification</h2>
                <p>Hello,</p>
                <p>Use the following code to complete your sign-in to JobZoid:</p>
                <div style="background-color: #f3f4f6; padding: 20px; font-size: 32px; font-weight: bold; text-align: center; letter-spacing: 5px; color: #1f2937; border-radius: 8px;">
                    {otp}
                </div>
                <p>This code will expire in 10 minutes.</p>
                <p style="font-size: 12px; color: #9ca3af;">If you didn't request this, please ignore this email.</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 10px; color: #9ca3af; text-align: center;">&copy; 2026 JobZoid Applicant Protection System</p>
            </div>
        </body>
    </html>
    """

    if not SMTP_USER or not SMTP_PASS:
        print("\n" + "="*50)
        print(f"DEBUG OTP FOR {receiver_email}: {otp}")
        print("="*50 + "\n")
        return True

    try:
        msg = MIMEMultipart()
        msg['From'] = f"JobZoid Security <{SMTP_USER}>"
        msg['To'] = receiver_email
        msg['Subject'] = subject
        msg.attach(MIMEText(body, 'html'))

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"Error sending email: {e}")
        print("\n" + "="*50)
        print(f"DEBUG OTP FOR {receiver_email}: {otp}")
        print("="*50 + "\n")
        return True

def generate_otp():
    return str(random.randint(100000, 999999))

def analyze_email_signals(headers_list):
    """
    Simulates AESD Passive Response Tracking.
    Identifies hiring signals based on email metadata (Sender, Subject).
    """
    signals = []
    
    keywords = {
        "INTERVIEW": ["interview", "schedule", "availability", "calendly", "meet"],
        "REJECTION": ["regret", "moving forward", "other candidates", "thank you for your interest"],
        "ACK": ["received", "application", "confirming"],
        "ATS": ["greenhouse", "workday", "lever", "breezy", "icims"]
    }

    for header in headers_list:
        subject = header.get("subject", "").lower()
        sender = header.get("from", "").lower()
        
        detected_type = "UNKNOWN"
        confidence = 0.5
        
        for sig_type, keys in keywords.items():
            if any(k in subject for k in keys) or any(k in sender for k in keys):
                detected_type = sig_type
                confidence = 0.9
                break
        
        if detected_type != "UNKNOWN":
            signals.append({
                "type": detected_type,
                "confidence": confidence,
                "timestamp": header.get("date"),
                "company_hint": sender.split('@')[-1].split('.')[0]
            })
            
    return signals
