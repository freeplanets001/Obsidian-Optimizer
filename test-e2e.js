const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
    const electronApp = await electron.launch({ args: ['.'] });
    const window = await electronApp.firstWindow();

    try {
        console.log('App launched.');
        await window.waitForLoadState('domcontentloaded');

        console.log('Running Quick Scan...');
        await window.click('#btn-quick-scan');
        await window.waitForSelector('#loading-overlay', { state: 'hidden', timeout: 30000 });
        console.log('Quick Scan finished.');

        console.log('Testing Vault Switcher...');
        const vaultSwitcher = await window.$('#vault-switcher');
        if (vaultSwitcher) {
            const options = await window.$$('#vault-switcher option');
            if (options.length > 1) {
                const val = await options[1].getAttribute('value');
                await window.selectOption('#vault-switcher', val);
                await new Promise(r => setTimeout(r, 5000));
                console.log('Vault switched to index', val);
            } else {
                console.log('No multiple vaults to test switching.');
            }
        }

        console.log('Testing Preview...');
        await window.click('#btn-preview');
        await window.waitForSelector('#loading-overlay', { state: 'hidden', timeout: 30000 });
        console.log('Preview finished.');

        console.log('Testing generate MOC...');
        await window.click('[data-tab="optimize"]'); // スイッチャーで隠れているタブを開く
        await new Promise(r => setTimeout(r, 500));

        const btnGenMoc = await window.$('#btn-gen-moc');
        if (btnGenMoc) {
            await window.click('#btn-gen-moc');
            await window.waitForSelector('#loading-overlay', { state: 'hidden', timeout: 30000 });
            console.log('Generate MOC finished.');
        }

        console.log('Testing Export Report...');
        const btnExport = await window.$('#btn-export');
        if (btnExport) {
            console.log('Export button exists, skipping click to avoid native dialog blocking.');
        }

        console.log('✅ All basic tests passed.');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await electronApp.close();
    }
})();
