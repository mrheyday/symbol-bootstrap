import Logger from '../logger/Logger';
import LoggerFactory from '../logger/LoggerFactory';
import { LogType } from '../logger/LogType';
import { BootstrapUtils } from './BootstrapUtils';
import { ConfigPreset } from '../model';
import { join } from 'path';
import { DockerCompose, DockerComposeService } from '../model/DockerCompose';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
export type ComposeParams = { target: string; user?: string; reset?: boolean; aws?: boolean };

const logger: Logger = LoggerFactory.getLogger(LogType.System);

const workingDir = BootstrapUtils.workingDir;

export class ComposeService {
    public static defaultParams: ComposeParams = { target: 'target', user: 'current', reset: false, aws: false };

    constructor(private readonly root: string, protected readonly params: ComposeParams) {}

    public async run(passedPresetData?: ConfigPreset): Promise<string> {
        const presetData = passedPresetData ?? BootstrapUtils.loadExistingPresetData(this.params.target);

        const currentDir = process.cwd();
        const target = join(currentDir, this.params.target);
        const targetDocker = join(target, `docker`);
        if (this.params.reset) {
            BootstrapUtils.deleteFolder(targetDocker);
        }

        const dockerFile = join(targetDocker, 'docker-compose.yml');
        if (fs.existsSync(dockerFile)) {
            logger.info(dockerFile + ' already exist. Reusing. (run -r to reset)');
            return dockerFile;
        }

        await BootstrapUtils.mkdir(join(this.params.target, 'state'));
        await BootstrapUtils.mkdir(targetDocker);
        await BootstrapUtils.generateConfiguration(presetData, join(this.root, 'config', 'docker'), targetDocker);

        const user: string | undefined = this.params.aws ? undefined : await this.resolveUser();

        const vol = (hostFolder: string, imageFolder: string): string => {
            return hostFolder + ':' + imageFolder;
        };

        logger.info(`creating docker-compose.yml from last used profile.`);

        const services: Record<string, DockerComposeService> = {};

        const resolvePorts = (internalPort: number, openPort: number | undefined | boolean | string): string[] => {
            if (!openPort) {
                return [];
            }
            if (openPort === true || openPort === 'true') {
                return [`${internalPort}:${internalPort}`];
            }
            return [`${openPort}:${internalPort}`];
        };

        const resolveImage = async (
            serviceName: string,
            image: string,
            volumes: string[],
        ): Promise<{ image: string; volumes: string[] | undefined }> => {
            if (this.params.aws) {
                const repository = 'nem-repository';
                const dockerfileContent = `FROM docker.io/${image}\n\n${volumes
                    .map((v) => {
                        const parts = v.split(':');
                        return `ADD ${parts[0].replace('../', '').replace('./', 'docker/')} ${parts[1]}`;
                    })
                    .join('\n')}\n`;
                const dockerFile = join(target, 'Dockerfile-' + serviceName);
                await BootstrapUtils.writeTextFile(dockerFile, dockerfileContent);
                await Promise.all(
                    volumes.map(async (v) => {
                        const parts = v.split(':');
                        await BootstrapUtils.mkdir(join(targetDocker, parts[0]));
                    }),
                );
                const generatedImageName = repository + ':' + serviceName;
                await BootstrapUtils.createImageUsingExec(target, dockerFile, generatedImageName);

                // aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 172617417348.dkr.ecr.us-east-1.amazonaws.com
                const absoluteImageUrl = `172617417348.dkr.ecr.us-east-1.amazonaws.com/${generatedImageName}`;

                await BootstrapUtils.exec(`docker tag ${generatedImageName} ${absoluteImageUrl}`);
                await BootstrapUtils.exec(`docker push ${absoluteImageUrl}`);

                return { image: generatedImageName, volumes: undefined };
            } else {
                return { image, volumes };
            }
        };

        await Promise.all(
            (presetData.databases || []).map(async (n) => {
                const databaseImageInfo = await resolveImage(n.name, presetData.mongoImage, [
                    vol(`./mongo`, `/userconfig/:ro`),
                    vol('../data/mongo', '/dbdata:rw'),
                    vol('../state', '/state'),
                ]);
                services[n.name] = {
                    container_name: n.name,
                    image: databaseImageInfo.image,
                    user,
                    command: `bash -c "/bin/bash /userconfig/mongors.sh ${n.name} & mongod --dbpath=/dbdata --bind_ip=${n.name}"`,
                    stop_signal: 'SIGINT',
                    ports: resolvePorts(27017, n.openPort),
                    volumes: databaseImageInfo.volumes,
                };

                // const databaseInitImageInfo = await resolveImage(n.name, presetData.mongoImage, [
                //     vol(`./mongo`, `/userconfig/:ro`),
                //     vol('../data/mongo', '/dbdata:rw'),
                //     vol('../state', '/state'),
                // ]);
                // services[n.name + '-init'] = {
                //     image: databaseInitImageInfo.image,
                //     user,
                //     command: 'bash -c "/bin/bash /userconfig/mongors.sh && touch /state/mongo-is-setup"',
                //     volumes: databaseInitImageInfo.volumes,
                //     depends_on: [n.name],
                // };
            }),
        );

        await Promise.all(
            (presetData.nodes || []).map(async (n) => {
                const nodeImageData = await resolveImage(n.name, presetData.symbolServerImage, [
                    vol(`../${workingDir}/${n.name}`, `/symbol-workdir`),
                    vol(`./userconfig`, `/symbol-commands`),
                    vol('../state', '/state'),
                ]);

                const nodeService = {
                    image: nodeImageData.image,
                    user,
                    command: `bash -c "/bin/bash /symbol-commands/runServerRecover.sh  ${n.name} && /bin/bash /symbol-commands/startServer.sh ${n.name}"`,
                    stop_signal: 'SIGINT',
                    depends_on: [] as string[],
                    restart: 'on-failure:2',
                    ports: resolvePorts(7900, n.openPort),
                    volumes: nodeImageData.volumes,
                };
                if (n.databaseHost) {
                    nodeService.depends_on.push(n.databaseHost);
                }
                services[n.name] = nodeService;
                if (n.brokerHost) {
                    services[n.brokerHost] = {
                        image: nodeService.image,
                        user,
                        command: `bash -c "/bin/bash /symbol-commands/runServerRecover.sh ${n.brokerHost} && /bin/bash /symbol-commands/startBroker.sh ${n.brokerHost}"`,
                        stop_signal: 'SIGINT',
                        ports: resolvePorts(7902, n.openBrokerPort),
                        restart: 'on-failure:2',
                        volumes: nodeService.volumes,
                    };
                    nodeService.depends_on.push(n.brokerHost);
                }
            }),
        );

        await Promise.all(
            (presetData.gateways || []).map(async (n) => {
                const gatewayImageInfo = await resolveImage(n.name, presetData.symbolRestImage, [
                    vol(`../${workingDir}/${n.name}`, `/symbol-workdir`),
                ]);

                services[n.name] = {
                    image: gatewayImageInfo.image,
                    user,
                    command: 'ash -c "cd /symbol-workdir && npm start --prefix /app/catapult-rest/rest /symbol-workdir/rest.json"',
                    stop_signal: 'SIGINT',
                    ports: resolvePorts(3000, n.openPort),
                    volumes: gatewayImageInfo.volumes,
                    depends_on: [n.databaseHost],
                    networks: {
                        default: {
                            ipv4_address: '172.20.0.10',
                        },
                    },
                };
            }),
        );

        const dockerCompose: DockerCompose = {
            version: '3',
            networks: {
                default: {
                    ipam: {
                        config: [
                            {
                                subnet: '172.20.0.0/24',
                            },
                        ],
                    },
                },
            },
            services: services,
        };

        await BootstrapUtils.writeYaml(dockerFile, dockerCompose);
        logger.info(`docker-compose.yml file created ${dockerFile}`);
        return dockerFile;
    }

    private async resolveUser(): Promise<string | undefined> {
        if (!this.params.user || this.params.user.trim() === '') {
            return undefined;
        }
        if (this.params.user === 'current') {
            return BootstrapUtils.getDockerUserGroup();
        }
        return this.params.user;
    }
}
