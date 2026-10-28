// Browser-visible settings. These are public settings, never secrets.
// Use ONLY a Supabase publishable key or legacy anon key here.
// Never paste a secret key, service_role key, database password, or SMTP credential.
export const CONFIG = Object.freeze({
  supabaseUrl: '',
  supabasePublicKey: '',
  // Analytics stays off until configured and the visitor explicitly opts in.
  analyticsId: '',
  // Owner explicitly requested enabling the purchase button on 28 October 2026.
  // Payment is followed by manual email delivery, never an automatic file unlock.
  guideSalesEnabled: true,
  guideCheckoutUrl: 'https://paypal.me/felicityhannah8/9USD',
  guideSupportEmail: 'felicityahawhale@gmail.com',
});
