import 'mocha';
import { BootstrapService, ConfigResult, Preset, StartParams } from '../../src/service';
import { expect } from '@oclif/test';
import {
    Account,
    Deadline,
    NetworkCurrencyLocal,
    PlainMessage,
    RepositoryFactoryHttp,
    TransactionService,
    TransferTransaction,
    UInt64,
} from 'symbol-sdk';

describe('BootstrapService', () => {
    it(' bootstrap config compose', async () => {
        const service = new BootstrapService('.');
        const config: StartParams = {
            preset: Preset.bootstrap,
            reset: true,
            aws: true,
            timeout: 60000 * 5,
            target: 'target/bootstrap-test',
            daemon: true,
            user: 'current',
        };

        await service.config(config);
        // const dockerFile = await service.compose(config);
        // console.log(dockerFile);
    });
});
