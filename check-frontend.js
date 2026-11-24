const fs = require('node:fs');
const path = require('node:path');
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
if (!scripts.length) throw new Error('No inline JavaScript found in index.html');
for (let i = 0; i < scripts.length; i++) new Function(scripts[i]);
for (const required of [
  'billingPlanCards', 'startSubscriptionCheckout', 'activateFreePlan',
  'loadOwnerDashboard', 'hydrateExistingSession',
  'Plans are available below. Sign in or create an account',
  'Plans could not be loaded from the server.'
]) {
  if (!html.includes(required)) throw new Error(`Expected billing UI function or element is missing: ${required}`);
}
console.log(`Frontend syntax check passed (${scripts.length} inline script block(s)).`);
