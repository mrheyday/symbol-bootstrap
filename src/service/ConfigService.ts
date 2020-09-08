import { BootstrapUtils } from './BootstrapUtils';
import {
    Account,
    Address,
    Convert,
    Deadline,
    LinkAction,
    MosaicId,
    MosaicNonce,
    NetworkType,
    Transaction,
    TransactionMapping,
    UInt64,
    VrfKeyLinkTransaction,
} from 'symbol-sdk';
import { CertificateService } from './CertificateService';
import Logger from '../logger/Logger';
import LoggerFactory from '../logger/LoggerFactory';
import { LogType } from '../logger/LogType';
import { NemgenService } from './NemgenService';
import { Addresses, ConfigAccount, ConfigPreset, NodeAccount, NodePreset, NodeType } from '../model';
import * as fs from 'fs';
import { join } from 'path';

/**
 * Defined presets.
 */
export enum Preset {
    bootstrap = 'bootstrap',
    testnet = 'testnet',
    lightPeer = 'lightPeer',
    light = 'light',
}

export interface ConfigParams {
    reset: boolean;
    preset: Preset;
    target: string;
    assembly?: string;
    customPreset?: string;
}

export interface ConfigResult {
    addresses: Addresses;
    presetData: ConfigPreset;
}

const logger: Logger = LoggerFactory.getLogger(LogType.System);

const workingDir = BootstrapUtils.workingDir;

export class ConfigService {
    public static defaultParams: ConfigParams = { target: 'target', preset: Preset.bootstrap, reset: false };

    constructor(private readonly root: string, private readonly params: ConfigParams) {}

    public toConfig(account: Account): ConfigAccount {
        return {
            privateKey: account.privateKey,
            publicKey: account.publicAccount.publicKey,
            address: account.address.plain(),
        };
    }

    public static getNetworkIdentifier(networkType: NetworkType): string {
        switch (networkType) {
            case NetworkType.MAIN_NET:
                return 'public';
            case NetworkType.TEST_NET:
                return 'public-test';
            case NetworkType.MIJIN:
                return 'mijin';
            case NetworkType.MIJIN_TEST:
                return 'mijin-test';
        }
        throw new Error(`Invalid Network Type ${networkType}`);
    }

    public static getNetworkName(networkType: NetworkType): string {
        switch (networkType) {
            case NetworkType.MAIN_NET:
                return 'public';
            case NetworkType.TEST_NET:
                return 'publicTest';
            case NetworkType.MIJIN:
                return 'mijin';
            case NetworkType.MIJIN_TEST:
                return 'mijinTest';
        }
        throw new Error(`Invalid Network Type ${networkType}`);
    }

    public generateAddresses(networkType: NetworkType, size: number): ConfigAccount[] {
        return ConfigService.getArray(size).map(() => this.toConfig(Account.generateNewAccount(networkType)));
    }

    public async generateNodeAccount(index: number, node: NodePreset, networkType: NetworkType): Promise<NodeAccount> {
        const type = node.type;
        const name = node.name || `${type}-${index}`;
        const signing = this.toConfig(Account.generateNewAccount(networkType));
        const vrf = this.toConfig(Account.generateNewAccount(networkType));
        const ssl = await new CertificateService(this.root, this.params).run(name);
        const friendlyName = node.friendlyName || ssl.publicKey.substr(0, 7);
        return { signing, vrf, ssl, type, name, friendlyName };
    }

    public async generateNodeAccounts(networkType: NetworkType, nodes: NodePreset[]): Promise<NodeAccount[]> {
        return Promise.all(nodes.map((node, index) => this.generateNodeAccount(index, node, networkType)));
    }

    public generateAddress(networkType: NetworkType): ConfigAccount {
        return this.toConfig(Account.generateNewAccount(networkType));
    }

    private static getArray(size: number): number[] {
        return [...Array(size).keys()];
    }

    public async run(): Promise<ConfigResult> {
        const configFolder = `${this.params.target}/config`;

        if (this.params.reset) {
            BootstrapUtils.deleteFolder(configFolder);
        }
        if (fs.existsSync(configFolder)) {
            logger.info('Config folder exist, ignoring configuration. (run -r to reset)');
            const presetData: ConfigPreset = BootstrapUtils.loadExistingPresetData(this.params.target);
            const addresses: Addresses = BootstrapUtils.loadExistingAddresses(this.params.target);
            return { presetData, addresses };
        }

        const presetData: ConfigPreset = BootstrapUtils.loadPresetData(
            this.root,
            this.params.preset,
            this.params.assembly,
            this.params.customPreset,
        );

        await fs.promises.mkdir(join(this.params.target, workingDir, `generated-addresses`), { recursive: true });
        const networkType = presetData.networkType;
        const addresses = await this.generateRandomConfiguration(networkType, presetData);
        this.completePresetDataWithRandomConfiguration(presetData, addresses, networkType);
        await BootstrapUtils.writeYaml(`${this.params.target}/${workingDir}/generated-addresses/addresses.yml`, addresses);

        await this.generateNodes(presetData, addresses);
        await this.generateNemesis(presetData, addresses);
        await this.generateGateways(presetData, addresses);

        await BootstrapUtils.writeYaml(`${this.params.target}/config/preset.yml`, presetData);
        logger.info(`Configuration generated.`);
        return { presetData, addresses };
    }

    private async generateNemesis(presetData: ConfigPreset, addresses: Addresses) {
        const copyTo = `${this.params.target}/${workingDir}/nemesis`;
        await BootstrapUtils.mkdir(`${copyTo}/seed/00000`);
        if (presetData.nemesis) {
            await this.generateNemesisConfig(presetData, addresses);
        } else {
            const copyFrom = presetData.nemesisSeedFolder || `${this.root}/presets/${this.params.preset}/seed`;
            await BootstrapUtils.generateConfiguration({}, copyFrom, copyTo);
        }

        await Promise.all(
            (addresses.nodes || []).map(async (account) => {
                const name = account.name;
                const dataFolder = join(this.params.target, workingDir, name, 'data');
                const nemesisFolder = `${this.params.target}/${workingDir}/nemesis`;
                await BootstrapUtils.generateConfiguration({}, `${nemesisFolder}/seed`, dataFolder);
                await BootstrapUtils.generateConfiguration({}, `${nemesisFolder}/data`, dataFolder);
            }),
        );
    }

    private completePresetDataWithRandomConfiguration(presetData: ConfigPreset, addresses: Addresses, networkType: NetworkType): void {
        presetData.networkIdentifier = ConfigService.getNetworkIdentifier(presetData.networkType);
        presetData.networkName = ConfigService.getNetworkName(presetData.networkType);
        if (!presetData.nemesisGenerationHashSeed) {
            presetData.nemesisGenerationHashSeed = addresses.nemesisGenerationHashSeed;
        }

        //How can it work?
        const ownerAddress = Address.createFromPublicKey(presetData.nemesisSignerPublicKey, networkType);

        if (!presetData.currencyMosaicId)
            presetData.currencyMosaicId = BootstrapUtils.toHex(
                MosaicId.createFromNonce(MosaicNonce.createFromNumber(0), ownerAddress).toHex(),
            );
        if (!presetData.harvestingMosaicId) {
            if (!presetData.nemesis) {
                throw new Error('nemesis must be defined!');
            }
            if (presetData.nemesis.mosaics && presetData.nemesis.mosaics.length > 1) {
                presetData.harvestingMosaicId = BootstrapUtils.toHex(
                    MosaicId.createFromNonce(MosaicNonce.createFromNumber(1), ownerAddress).toHex(),
                );
            } else {
                presetData.harvestingMosaicId = presetData.currencyMosaicId;
            }
        }
    }

    private async generateRandomConfiguration(networkType: NetworkType, presetData: ConfigPreset): Promise<Addresses> {
        const addresses: Addresses = {
            networkType: networkType,
            nemesisGenerationHashSeed:
                presetData.nemesisGenerationHashSeed || Account.generateNewAccount(networkType).publicAccount.publicKey,
        };

        if (presetData.nodes) {
            addresses.nodes = await this.generateNodeAccounts(networkType, presetData.nodes);
        }

        if (presetData.gateways) {
            addresses.gateways = this.generateAddresses(networkType, presetData.gateways.length);
        }
        if (presetData.nemesis) {
            addresses.nemesisSigner = this.generateAddress(networkType);
            if (!presetData.nemesis.nemesisSignerPrivateKey && addresses.nemesisSigner) {
                presetData.nemesis.nemesisSignerPrivateKey = addresses.nemesisSigner.privateKey;
            }
            if (presetData.nemesis.mosaics) {
                const mosaics: Record<string, ConfigAccount[]> = {};
                presetData.nemesis.mosaics.forEach((m) => {
                    mosaics[m.name] = this.generateAddresses(networkType, m.accounts);
                });

                presetData.nemesis.mosaics.forEach((m) => {
                    const accounts = mosaics[m.name];
                    if (!m.currencyDistributions) {
                        const nodes = addresses.nodes || [];
                        const totalAccounts = (m.accounts || 0) + nodes.length;
                        const amountPerAccount = Math.floor(m.supply / totalAccounts);
                        m.currencyDistributions = [
                            ...accounts.map((a) => ({ address: a.address, amount: amountPerAccount })),
                            ...nodes.map((n) => ({ address: n.signing.address, amount: amountPerAccount })),
                        ];
                        if (m.currencyDistributions.length)
                            m.currencyDistributions[0].amount += m.supply - totalAccounts * amountPerAccount;
                    }
                    const supplied = m.currencyDistributions.map((d) => d.amount).reduce((a, b) => a + b, 0);
                    if (m.supply != supplied) {
                        throw new Error(`Invalid nemgen total supplied value, expected ${m.supply} but total is ${supplied}`);
                    }
                });
                addresses.mosaics = mosaics;
            }
        }

        if (!presetData.nemesisSignerPublicKey && addresses.nemesisSigner) {
            presetData.nemesisSignerPublicKey = addresses.nemesisSigner.publicKey;
        }

        return addresses;
    }

    private async generateNodes(presetData: ConfigPreset, addresses: Addresses) {
        await Promise.all(
            (addresses.nodes || []).map(
                async (account, index) => await this.generateNodeConfiguration(account, index, presetData, addresses),
            ),
        );
    }

    private async generateNodeConfiguration(account: NodeAccount, index: number, presetData: ConfigPreset, addresses: Addresses) {
        const copyFrom = join(this.root, 'config', 'node');
        const name = account.name;

        const outputFolder = join(this.params.target, workingDir, name, 'userconfig');
        const nodePreset = (presetData.nodes || [])[index];
        const generatedContext = {
            name: name,
            friendlyName: nodePreset?.friendlyName || account.friendlyName,
            harvesterSigningPrivateKey: account.signing.privateKey,
            harvesterVrfPrivateKey: account.vrf.privateKey,
        };
        const templateContext: any = { ...presetData, ...generatedContext, ...nodePreset };
        await BootstrapUtils.generateConfiguration(templateContext, copyFrom, outputFolder);
        await this.generateP2PFile(presetData, addresses, outputFolder, NodeType.PEER_NODE, 'peers-p2p.json');
        await this.generateP2PFile(presetData, addresses, outputFolder, NodeType.API_NODE, 'peers-api.json');
    }

    private async generateP2PFile(
        presetData: ConfigPreset,
        addresses: Addresses,
        outputFolder: string,
        type: NodeType,
        jsonFileName: string,
    ) {
        const thisNetworkKnownPeers = (addresses.nodes || [])
            .map((node, index) => {
                if (node.type !== type) {
                    return undefined;
                }
                const nodePresetData = (presetData.nodes || [])[index];
                const name = node.name;
                return {
                    publicKey: node.ssl.publicKey,
                    endpoint: {
                        host: name,
                        port: 7900,
                    },
                    metadata: {
                        name: name,
                        roles: nodePresetData.roles,
                    },
                };
            })
            .filter((i) => i);
        const globalKnownPeers = presetData.knownPeers?.[type] || [];
        const data = {
            _info: `this file contains a list of ${type} peers`,
            knownPeers: [...thisNetworkKnownPeers, ...globalKnownPeers],
        };
        await fs.promises.writeFile(join(outputFolder, `resources`, jsonFileName), JSON.stringify(data, null, 2));
    }

    private async generateNemesisConfig(presetData: ConfigPreset, addresses: Addresses) {
        if (!presetData.nemesis) {
            throw new Error('nemesis must not be defined!');
        }
        const nemesisWorkingDir = join(`${this.params.target}`, workingDir, 'nemesis');
        const transactionsDirectory = join(nemesisWorkingDir, presetData.nemesis.transactionsDirectory || presetData.transactionsDirectory);
        await BootstrapUtils.mkdir(transactionsDirectory);
        const copyFrom = join(this.root, `config`, `nemesis`);
        const moveTo = join(nemesisWorkingDir, `userconfig`);
        const templateContext = { ...(presetData as any), addresses };
        await Promise.all((addresses.nodes || []).map((n) => this.createVrfTransaction(transactionsDirectory, presetData, n)));

        if (presetData.nemesis.mosaics && (presetData.nemesis.transactions || presetData.nemesis.balances)) {
            logger.info('Opt In mode is ON!!! balances or transactions have been provided');
            if (presetData.nemesis.transactions) {
                const transactionHashes: string[] = [];
                const transactions = (
                    await Promise.all(
                        Object.entries(presetData.nemesis.transactions || {})
                            .map(([key, payload]) => {
                                const transactionHash = Transaction.createTransactionHash(
                                    payload,
                                    Array.from(Convert.hexToUint8(presetData.nemesisGenerationHashSeed)),
                                );
                                if (transactionHashes.indexOf(transactionHash) > -1) {
                                    logger.warn(`Transaction ${key} wth hash ${transactionHash} already exist. Excluded from folder.`);
                                    return undefined;
                                }
                                transactionHashes.push(transactionHash);
                                return this.storeTransaction(transactionsDirectory, key, payload);
                            })
                            .filter((p) => p),
                    )
                ).filter((p) => p);
                logger.info(`Found ${transactions.length} opted in transactions.`);
            }
            const currencyMosaic = presetData.nemesis.mosaics[0];
            const nglAccount = currencyMosaic.currencyDistributions[0];
            const originalNglAccountBalance = nglAccount.amount;
            if (!nglAccount) {
                throw Error('"NGL" account could not be found for opt in!');
            }
            let totalOptedInBalance = 0;
            if (presetData.nemesis.balances) {
                Object.entries(presetData.nemesis.balances || {}).forEach(([address, amount]) => {
                    totalOptedInBalance += amount;
                    currencyMosaic.currencyDistributions.push({ address, amount });
                });
                logger.info(
                    `Removing ${
                        Object.keys(presetData.nemesis.balances).length
                    } accounts (total of ${totalOptedInBalance}) from "ngl" account ${nglAccount.address}`,
                );
            }

            nglAccount.amount = nglAccount.amount - totalOptedInBalance;

            const providedBalances = Object.values(currencyMosaic.currencyDistributions)
                .map((d) => d.amount)
                .reduce((a, b) => a + b, 0);

            const currentBalance = providedBalances;

            if (nglAccount.amount < 1) {
                throw new Error(
                    `NGL account didn't have enough balance (${originalNglAccountBalance}) to paid all the supplied optedin namespaces and accounts of ${currentBalance}`,
                );
            }

            if (currentBalance !== currencyMosaic.supply) {
                throw new Error(
                    `Current supplied balance of ${currentBalance} is different from expected supply of ${currencyMosaic.supply}`,
                );
            }
        }

        await BootstrapUtils.generateConfiguration(templateContext, copyFrom, moveTo);
        await new NemgenService(this.root, this.params).run(presetData);
    }

    private async createVrfTransaction(transactionsDirectory: string, presetData: ConfigPreset, node: NodeAccount): Promise<Transaction> {
        const deadline = (Deadline as any)['createFromDTO']('1');
        const vrf = VrfKeyLinkTransaction.create(deadline, node.vrf.publicKey, LinkAction.Link, presetData.networkType, UInt64.fromUint(0));
        const account = Account.createFromPrivateKey(node.signing.privateKey, presetData.networkType);
        const signedTransaction = account.sign(vrf, presetData.nemesisGenerationHashSeed);
        return await this.storeTransaction(transactionsDirectory, `vrf_${node.name}`, signedTransaction.payload);
    }

    private async storeTransaction(transactionsDirectory: string, name: string, payload: string): Promise<Transaction> {
        const transaction = TransactionMapping.createFromPayload(payload);
        await fs.promises.writeFile(`${transactionsDirectory}/${name}.bin`, Convert.hexToUint8(payload));
        return transaction as Transaction;
    }

    private generateGateways(presetData: ConfigPreset, addresses: Addresses) {
        return Promise.all(
            (addresses.gateways || []).map(async (account, index: number) => {
                const copyFrom = join(this.root, 'config', 'rest-gateway');

                const generatedContext = {
                    restPrivateKey: account.privateKey,
                };
                const gatewayPreset = (presetData.gateways || [])[index];
                const templateContext: any = { ...presetData, ...generatedContext, ...gatewayPreset };
                const name = templateContext.name || `rest-gateway-${index}`;
                const moveTo = join(this.params.target, workingDir, name);
                await BootstrapUtils.generateConfiguration(templateContext, copyFrom, moveTo);
                const apiNodeConfigFolder = join(this.params.target, workingDir, gatewayPreset.apiNodeName, 'userconfig', 'resources');
                await BootstrapUtils.generateConfiguration({}, apiNodeConfigFolder, join(moveTo, 'api-node-config'));
            }),
        );
    }
}
