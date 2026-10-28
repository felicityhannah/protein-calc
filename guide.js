// Owner-authorized manual checkout. Set CONFIG.guideSalesEnabled=false to pause sales.
// A checkout link or return visit never establishes payment or unlocks a file.
const approvedCheckout = 'https://paypal.me/felicityhannah8/9USD';

export function getGuideOffer(config = {}) {
  if (config.guideSalesEnabled !== true) return null;
  const email = String(config.guideSupportEmail || '').trim();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(email) || /[\r\n]/.test(email)) return null;
  try {
    const checkout = new URL(config.guideCheckoutUrl);
    if (checkout.href !== approvedCheckout) return null;
    return Object.freeze({ checkoutUrl:checkout.href, supportEmail:email, priceUsd:9, deliveryHours:48, refundDays:7 });
  } catch { return null; }
}

export function buildGuideEmail(offer, subject, body) {
  if (!offer || !getGuideOffer({guideSalesEnabled:true, guideCheckoutUrl:offer.checkoutUrl, guideSupportEmail:offer.supportEmail})) throw new TypeError('Guide checkout is not configured.');
  return `mailto:${offer.supportEmail}?subject=${encodeURIComponent(String(subject).replace(/[\r\n]+/g,' '))}&body=${encodeURIComponent(String(body))}`;
}
