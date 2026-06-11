const SITE = 'https://call-buddy-omega.vercel.app';

function initBillingToggle() {
  const monthly = document.getElementById('bill-monthly');
  const annual = document.getElementById('bill-annual');
  if (!monthly || !annual) return;

  const prices = {
    starter: { monthly: 19, annual: 15 },
    pro: { monthly: 49, annual: 39 },
    team: { monthly: 99, annual: 79 }
  };

  function updatePrices(interval) {
    document.querySelectorAll('[data-tier-price]').forEach(el => {
      const tier = el.dataset.tierPrice;
      const p = prices[tier]?.[interval];
      if (!p) return;
      el.querySelector('.price-amount').innerHTML = '$' + p + '<sub>/month</sub>';
      const note = el.querySelector('.price-annual-note');
      if (note) note.style.display = interval === 'annual' ? 'block' : 'none';
    });
    monthly.classList.toggle('active', interval === 'monthly');
    annual.classList.toggle('active', interval === 'annual');
    monthly.setAttribute('aria-pressed', interval === 'monthly');
    annual.setAttribute('aria-pressed', interval === 'annual');
  }

  monthly.addEventListener('click', () => updatePrices('monthly'));
  annual.addEventListener('click', () => updatePrices('annual'));
}

document.addEventListener('DOMContentLoaded', initBillingToggle);
