import { expect, test } from '@playwright/test';

test('small screens can open ledgers, watch a shipment, and still interact with the map', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const ledgers = page.getByRole('button', { name: 'Ledgers', exact: true });
  const bodies = page.getByRole('tab', { name: 'Bodies', exact: true });
  await expect(bodies).toBeHidden();
  await ledgers.click();
  await expect(bodies).toBeVisible();
  await expect(ledgers).toHaveAttribute('aria-expanded', 'true');
  // Playwright's hit test rejects this click if the open drawer blocks the exposed map.
  await page.locator('canvas').click({ position: { x: 350, y: 720 }, trial: true });
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(bodies).toBeHidden();
  await expect(page.getByLabel('All routes')).toBeChecked();
  await expect(page.getByRole('button', { name: /Map layers/i })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('region', { name: 'Time controls' })).toBeVisible();

  const watch = page.getByRole('button', { name: /Watch shipment/i });
  await expect(watch).toBeEnabled({ timeout: 10_000 });
  await watch.click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeDisabled();
});

test('desktop overview collapses map layers, clusters sites, opens shortcuts, and watches a shipment', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('All routes')).toBeChecked();
  const mapLayers = page.getByRole('button', { name: /Map layers/i });
  await expect(mapLayers).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Moon orbits')).toBeHidden();
  await mapLayers.click();
  await expect(mapLayers).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Moon orbits')).not.toBeChecked();

  // Multi-site planets collapse into a cluster badge at system overview; clicking zooms in.
  const cluster = page
    .locator('.marker--cluster')
    .filter({ hasText: /\d+ sites/ })
    .first();
  await expect(cluster).toBeVisible();
  await cluster.click();
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeEnabled();
  await page.keyboard.press('h');
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeDisabled();

  const help = page.getByRole('button', { name: 'Keyboard and mouse shortcuts' });
  await help.click();
  await expect(page.getByRole('region', { name: 'Controls', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Controls', exact: true })).toBeHidden();

  const watch = page.getByRole('button', { name: /Watch shipment/i });
  await expect(watch).toBeEnabled({ timeout: 10_000 });
  await watch.click();
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
});

test('ledger keys, time shortcuts and body history work in Chromium', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tablist');
  await tabs.getByRole('tab', { name: 'Companies' }).focus();
  await page.keyboard.press('End');
  const bodies = tabs.getByRole('tab', { name: 'Bodies' });
  await expect(bodies).toBeFocused();
  await page.keyboard.press('Space');
  await expect(bodies).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  const list = page.getByRole('tabpanel', { name: 'Bodies' });
  const selectBody = async (name: string) => {
    await list.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  };
  await selectBody('Earth');
  await selectBody('Mars');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('heading', { level: 1, name: 'Earth', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('heading', { level: 1, name: 'Mars', exact: true })).toBeVisible();
  await page.locator('canvas').click({ position: { x: 850, y: 180 } });
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('WebGL renders startup and a focused body without shader errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/shader|program.*valid|WebGL/i.test(message.text()) && message.type() === 'error')
      errors.push(message.text());
  });
  await page.goto('/');
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node) => !!node.getContext('webgl2'))).toBe(true);
  const renderedFrames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  await renderedFrames();
  await page.getByRole('tab', { name: 'Bodies' }).click();
  await page
    .getByRole('tabpanel', { name: 'Bodies' })
    .getByRole('button', { name: 'Earth', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Earth', exact: true })).toBeVisible();
  // CameraRig takes 1.4 seconds to zoom in. Keep observing through that animation.
  await page.waitForTimeout(1_500);
  await renderedFrames();
  expect(errors).toEqual([]);
});
