import { formatCents } from './utils.js';

export const PALETTE = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

// Compact doughnut for a KPI card, matching the Payroll "Cost by Department" card. Values are in cents.
export function donutConfig(labels, values, colors = labels.map((_, i) => PALETTE[i % PALETTE.length])) {
  return {
    data: { labels, datasets: [{ data: values.map(v => v / 100), backgroundColor: colors, borderWidth: 0 }] },
    options: {
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: ${formatCents(Math.round(c.parsed * 100))}` } },
      },
    },
  };
}

// Compact area line for a KPI card, matching the Payroll "Payroll Over Time" card. Values are in cents.
export function trendConfig(labels, values, label = 'Total') {
  return {
    data: {
      labels,
      datasets: [{ label, data: values.map(v => v / 100), borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.08)', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2 }],
    },
    options: {
      scales: { y: { beginAtZero: true, ticks: { callback: v => '€' + v.toLocaleString() }, grid: { color: '#f3f4f6' } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => formatCents(Math.round(c.parsed.y * 100)) } } },
    },
  };
}
