import sgMail from '@sendgrid/mail';

const isProduction = process.env.NODE_ENV === 'production';
const apiKey = process.env.SENDGRID_API_KEY || '';
const sender = process.env.SENDER_EMAIL || 'no-reply@gomelcars.local';

let enabled = false;
if (apiKey) {
  try {
    sgMail.setApiKey(apiKey);
    enabled = true;
    console.log('SendGrid email service is enabled');
  } catch (e) {
    console.error('Failed to initialize SendGrid:', e.message);
    enabled = false;
  }
} else {
  console.warn('SendGrid API key not found. Emails will not be sent in production.');
}

export async function sendOtpEmail({ to, code, purpose }) {
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

  // In development or when SendGrid is not enabled, log the OTP to console
  if (!isProduction || !enabled) {
    console.log('\n=== OTP for Development ===');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`OTP Code: ${code}`);
    console.log('=========================\n');
    
    if (!enabled) {
      return { 
        sent: false, 
        reason: 'sendgrid_disabled',
        debug: { code, to, purpose }
      };
    }
  }

  // In production with SendGrid enabled, send the actual email
  const msg = { to, from: sender, subject, text, html };
  try {
    await sgMail.send(msg);
    console.log(`OTP email sent to ${to}`);
    return { sent: true };
  } catch (e) {
    console.error('Failed to send OTP email:', e.message);
    return { 
      sent: false, 
      error: e?.message || 'send_failed',
      debug: { code, to, purpose }
    };
  }
}
