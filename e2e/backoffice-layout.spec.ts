import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const html = readFileSync(new URL('../backoffice/index.html', import.meta.url), 'utf8')
  .replace(/<link[^>]+>/g, '')
  .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const css = readFileSync(new URL('../backoffice/styles.css', import.meta.url), 'utf8');

for (const width of [320, 375, 760, 1024, 1440]) {
  test(`source table wraps within its container at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(html);
    await page.addStyleTag({ content: css });
    await page.locator('#sources').evaluate(element => { element.hidden = false; });
    await page.locator('#source-rows').evaluate(element => {
      const row = document.createElement('tr');
      for (const text of [
        'A source with a long name and a-very-long-domain.example.ch',
        'seller, marketplace',
        'computers, electronics, food delivery, groceries, fashion, watches, jewelry, eyewear, beauty, health, pets, toys baby, home, sports, music, office, books, auto, general',
        'AT, BE, CH, DE, DK, ES, FI, FR, GB, IE, IT, LU, NL, NO, PL, PT, SE, US',
        '2',
      ]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const state = document.createElement('td');
      const badge = document.createElement('span'); badge.className = 'badge off'; badge.textContent = 'Disabled';
      state.append(badge); row.append(state); element.replaceChildren(row);
    });

    const layout = await page.locator('#sources .table-wrap').evaluate(element => {
      const verticals = element.querySelector('tbody td:nth-child(3)')!;
      const countries = element.querySelector('tbody td:nth-child(4)')!;
      const range = document.createRange(); range.selectNodeContents(verticals);
      const verticalLines = range.getClientRects().length;
      range.selectNodeContents(countries);
      return {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        tableWidth: element.querySelector('table')!.getBoundingClientRect().width,
        verticalLines,
        countryLines: range.getClientRects().length,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.tableWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.verticalLines).toBeGreaterThan(1);
    expect(layout.countryLines).toBeGreaterThan(1);
    await expect(page.locator('#history table')).toHaveCSS('white-space', 'nowrap');
  });
}
