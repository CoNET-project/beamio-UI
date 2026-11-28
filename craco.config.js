const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');
const path = require('path');
const fs = require('fs');

function ForceAsyncSplitPlugin() {}
ForceAsyncSplitPlugin.prototype.apply = function (compiler) {
    compiler.hooks.environment.tap('ForceAsyncSplitPlugin', () => {
        // No shared async chunks. The chat worker's importScripts of those
        // chunks never finishes, so the relay cannot open.
        compiler.options.optimization = compiler.options.optimization || {}
        if (process.env.NODE_ENV !== 'production') {
            compiler.options.optimization.splitChunks = false
            process.stderr.write('[Build] dev splitChunks disabled so the chat worker is one script\n')
        }
    })
}

function WholeChatWorkerPlugin() {}
WholeChatWorkerPlugin.prototype.apply = function (compiler) {
    compiler.hooks.compilation.tap('WholeChatWorkerPlugin', (compilation) => {
        compilation.hooks.childCompiler.tap('WholeChatWorkerPlugin', (childCompiler, compilerName) => {
            if (!/worker/i.test(String(compilerName))) return
            const optimization = childCompiler.options.optimization || {}
            childCompiler.options.optimization = {
                ...optimization,
                splitChunks: false,
                runtimeChunk: false,
            }
            process.stderr.write('[Build] inline chat worker chunks (' + compilerName + ')\n')
        })
    })
}

function BuildProgressPlugin() {
    this.startTime = null;
}
BuildProgressPlugin.prototype.apply = function (compiler) {
    const self = this;
    compiler.hooks.environment.tap('BuildProgressPlugin', () => {
        process.stderr.write('[Build] Webpack compiler created\n');
    });
    compiler.hooks.compile.tap('BuildProgressPlugin', () => {
        self.startTime = Date.now();
        process.stderr.write('[Build] 0% - Compiling...\n');
    });
    compiler.hooks.compilation.tap('BuildProgressPlugin', () => {
        process.stderr.write('[Build] 20% - Building modules...\n');
    });
    compiler.hooks.emit.tap('BuildProgressPlugin', () => {
        const elapsed = ((Date.now() - self.startTime) / 1000).toFixed(1);
        process.stderr.write(`[Build] 80% - Emitting assets... (${elapsed}s)\n`);
    });
    compiler.hooks.done.tap('BuildProgressPlugin', () => {
        const elapsed = ((Date.now() - self.startTime) / 1000).toFixed(1);
        process.stderr.write(`[Build] 100% - Done in ${elapsed}s\n`);
    });
};

function shouldShowRuntimeOverlayError(error) {
    const message = error && error.message ? String(error.message) : '';
    // Chromium ResizeObserver loop is benign; the overlay otherwise covers Discover.
    return !/ResizeObserver loop/i.test(message);
}

module.exports = {
    devServer: (devServerConfig) => {
        const client = devServerConfig.client || {};
        const overlay =
            typeof client.overlay === 'object' && client.overlay
                ? { ...client.overlay }
                : { errors: true, warnings: false };
        overlay.runtimeErrors = shouldShowRuntimeOverlayError;
        devServerConfig.client = { ...client, overlay };
        return devServerConfig;
    },
    style: {
        css: {
            loaderOptions: (options) => {
                options.url = options.url ?? {};
                if (typeof options.url === 'object' && !options.url.filter) {
                    options.url.filter = (url) => !/^https?:\/\//i.test(url);
                }
                return options;
            }
        }
    },
    webpack: {
        alias: {
            '@': path.resolve(__dirname, 'src'), // 让 @ 指向 src 目录
        },
        configure: (webpackConfig) => {
            webpackConfig.cache = { type: 'filesystem' };
            webpackConfig.plugins = webpackConfig.plugins || [];
            webpackConfig.plugins.push(new BuildProgressPlugin());
            webpackConfig.plugins.push(new WholeChatWorkerPlugin());
            webpackConfig.plugins.push(new ForceAsyncSplitPlugin());
            // QA boot markers: the switch is a build-time constant, so a Release bundle folds the marker branch away
            // and the "[BeamioBoot]" literal is not shipped. Only a build with REACT_APP_BEAMIO_BOOT_TRACE=true keeps it.
            webpackConfig.plugins.push(new webpack.DefinePlugin({
                'process.env.REACT_APP_BEAMIO_BOOT_TRACE': JSON.stringify(process.env.REACT_APP_BEAMIO_BOOT_TRACE === 'true' ? 'true' : 'false'),
                // New-account registration (accountCreateRegister) and first-identity status: QA builds only until accepted.
                'process.env.REACT_APP_NEW_ACCOUNT_REGISTRATION': JSON.stringify(process.env.REACT_APP_NEW_ACCOUNT_REGISTRATION === 'true' ? 'true' : 'false'),
                // QA-only bridge command counter (utils/qaBridgeCounter.ts): a build-time constant, so every other build folds the counter away.
                'process.env.REACT_APP_QA_BRIDGE_COUNTER': JSON.stringify(process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true' ? 'true' : 'false'),
                // QA-only receipt-order hook (utils/qaAckOrder.ts): a build-time constant, so every other build folds the hook, its global name and its text away.
                'process.env.REACT_APP_QA_ACK_ORDER_HOOK': JSON.stringify(process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' ? 'true' : 'false'),
            }));
            // reproducibility: ethers and openpgp are peer dependencies of the chat SDK. A clean install (npm ci in vendor/conet-chat-sdk, then the app) puts a SECOND copy of each under
            // vendor/conet-chat-sdk/node_modules, and the SDK's imports would then bundle a second ethers and a second openpgp (+0.58 MB in the entry, and two copies whose classes do not
            // match each other). The development machine hid this because the SDK's node_modules/ethers and /openpgp were symlinks to the app's copies. So an import of these two packages that
            // comes from the SDK is resolved from the app's own directory, exactly like the app's own imports: one copy, whatever the install layout is.
            webpackConfig.plugins.push(new webpack.NormalModuleReplacementPlugin(/^(ethers|openpgp)(\/.*)?$/, (resource) => {
                if (/[\\/]conet-chat-sdk[\\/]/.test(String(resource.context || ''))) resource.context = __dirname
            }));
            webpackConfig.plugins.forEach((plugin) => {
                const name = plugin && plugin.constructor && plugin.constructor.name
                if (name !== 'ReactRefreshPlugin') return
                plugin.options = plugin.options || {}
                const prev = plugin.options.exclude
                const extra = [/conet-chat-sdk[\\/]dist[\\/]worker/]
                plugin.options.exclude = Array.isArray(prev) ? prev.concat(extra) : prev ? [prev].concat(extra) : extra
            })

            // SDK pin: the app's node_modules can be a link to a SHARED install whose @conet.project/chat-sdk points at ANOTHER worktree's SDK (it did: SilentPassUI/node_modules ->
            // home-bridge-deferred-sdk/vendor). A build must use THIS worktree's vendor/conet-chat-sdk, whatever node_modules holds. The two import specifiers the app uses are aliased to its dist, the build FAILS if that
            // dist is missing (it is produced by `npm --prefix vendor/conet-chat-sdk run build`, prebuild:react), and CRA's ModuleScopePlugin is told that this one directory outside src/ is allowed.
            const sdkDir = path.resolve(__dirname, 'vendor', 'conet-chat-sdk');
            const sdkIndex = path.join(sdkDir, 'dist', 'index.js');
            const sdkWorker = path.join(sdkDir, 'dist', 'worker', 'entry.js');
            if (!fs.existsSync(sdkIndex) || !fs.existsSync(sdkWorker)) {
                throw new Error('[Build] the pinned chat SDK dist is missing: ' + sdkDir + '/dist (run: npm --prefix vendor/conet-chat-sdk run build)');
            }
            webpackConfig.resolve.alias = { ...(webpackConfig.resolve.alias || {}), '@conet.project/chat-sdk$': sdkIndex, '@conet.project/chat-sdk/worker': sdkWorker };
            webpackConfig.resolve.plugins = (webpackConfig.resolve.plugins || []).map((plugin) => {
                if (!plugin || !plugin.constructor || plugin.constructor.name !== 'ModuleScopePlugin') return plugin;
                return new plugin.constructor(plugin.appSrcs, [...(plugin.allowedFiles || []), path.join(sdkDir, 'package.json')]);
            });
            process.stderr.write('[Build] chat SDK pinned to ' + sdkDir + '\n');

            // CRA puts source-map-loader on a top-level rule, not inside oneOf.
            // Missing maps under hoisted node_modules (bs58 → base-x) fail the compile.
            const excludeNodeSourceMaps = (rule) => {
                if (!rule || typeof rule !== 'object') return;
                if (rule.loader && String(rule.loader).includes('source-map-loader')) {
                    rule.exclude = /node_modules/;
                }
                for (const key of ['oneOf', 'rules', 'use']) {
                    if (Array.isArray(rule[key])) rule[key].forEach(excludeNodeSourceMaps);
                }
            };
            webpackConfig.module.rules.forEach(excludeNodeSourceMaps);
            webpackConfig.ignoreWarnings = [
                ...(webpackConfig.ignoreWarnings || []),
                /Failed to parse source map/,
            ];
            // The chat worker must be one classic script. Split vendor chunks
            // are loaded with importScripts and never finish, so voice listen
            // has no worker and the call reports that the relay could not open.
            webpackConfig.optimization = webpackConfig.optimization || {}
            // Keep OpenPGP inside the chat worker script. Shared async vendor
            // chunks do not finish loading in that worker, so voice listen
            // never starts and the call says the relay could not open.
            // A classic Worker cannot rely on CRA's async vendor chunks:
            // importScripts() in the emitted worker never completes there.
            // Keep the worker and its OpenPGP/ethers dependencies in one
            // executable script in development and production.
            webpackConfig.optimization.splitChunks = false
            webpackConfig.optimization.runtimeChunk = false
            if (process.env.NODE_ENV === 'production') {
                webpackConfig.optimization.minimizer = [
                    new TerserPlugin({
                        terserOptions: {
                            compress: {
                                drop_console: true, // 去除 console
                                drop_debugger: true // 去除 debugger
                            }
                        }
                    })
                ];
            }
            return webpackConfig;
        }
    },
    // (2026-11-14): test-only alias mapping, so jest can load the same '@/'modules the webpack build resolves
    // (tsconfig "@/*" -> src). Runtime and build output are not changed.
    jest: {
        configure: {
            moduleNameMapper: {
                '^@/(.*)$': '<rootDir>/src/$1',
            },
        },
    },
};