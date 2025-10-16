import sgMail from '@sendgrid/mail';

const apiKey = process.env.SENDGRID_API_KEY || '';
const sender = process.env.SENDER_EMAIL || 'no-reply@gomelcars.local';

let enabled = false;
if (apiKey) {
  try {
    sgMail.setApiKey(apiKey);
    enabled = true;
  } catch (e) {
    enabled = false;
  }
}

export async function sendOtpEmail({ to, code, purpose }) {
  if (!enabled) return { sent: false, reason: 'sendgrid_disabled' };
  const subjectMap = {
    login: 'Your Gomel Cars Login OTP',
    signup: 'Verify your Gomel Cars account',
    reset: 'Reset your Gomel Cars password',
  };
  const subject = subjectMap[purpose] || 'Your Gomel Cars OTP';
  const text = `Your OTP code is ${code}. It will expire in 10 minutes.`;
  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.6">
    <h2>${subject}</h2>
    <p>Your OTP code is:</p>
    <div style="font-size:28px;font-weight:bold;letter-spacing:3px">${code}</div>
    <p style="color:#555">This code will expire in 10 minutes. If you did not request this, you can ignore this email.</p>
  </div>`;
  const msg = { to, from: sender, subject, text, html };
  try {
    await sgMail.send(msg);
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e?.message || 'send_failed' };
  }
}
