// Owner-authorized manual payment. Set CONFIG.guideSalesEnabled=false to pause sales.
// Opening the portal or returning never establishes payment or unlocks a file.
const officialPayPalPortal = 'https://www.paypal.com/';
const approvedPayPalEmail = 'felicityahawhale@gmail.com';

function validEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const email = value.trim();
  const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
  if (!emailPattern.test(email)) return null;
  const local = email.slice(0, email.indexOf('@'));
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  return email;
}

export function getGuideOffer(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.guideSalesEnabled !== true) return null;
  const supportEmail = validEmail(config.guideSupportEmail);
  const payPalEmail = validEmail(config.guidePayPalEmail);
  if (!supportEmail || !payPalEmail || payPalEmail !== approvedPayPalEmail) return null;
  // Exact string match rejects alternate hosts, paths, query strings and redirects.
  if (config.guideCheckoutUrl !== officialPayPalPortal) return null;
  return Object.freeze({ checkoutUrl:officialPayPalPortal, supportEmail, payPalEmail,
    priceUsd:9, deliveryHours:48, refundDays:7 });
}

export function buildGuideEmail(offer, subject, body) {
  const validated = offer && getGuideOffer({guideSalesEnabled:true, guideCheckoutUrl:offer.checkoutUrl,
    guideSupportEmail:offer.supportEmail, guidePayPalEmail:offer.payPalEmail});
  if (!validated) throw new TypeError('Guide checkout is not configured.');
  const recipient = encodeURIComponent(validated.supportEmail).replace(/%40/g,'@');
  return `mailto:${recipient}?subject=${encodeURIComponent(String(subject).replace(/[\r\n]+/g,' '))}&body=${encodeURIComponent(String(body))}`;
}
