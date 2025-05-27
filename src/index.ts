#!/usr/bin/env node

import { program } from 'commander';
import { GitHubService, GitHubServiceOptions } from './services/github';
import { TerraformParser } from './parsers/terraform';
import { Logger, LogLevel } from './services/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

// Initialize the logger
const logger = Logger.forComponent('Main');

/** Generate a simple HTML report */
function generateHtmlReport(result: {
    metadata: any;
    modules: ReturnType<TerraformParser['parseModules']>;
    summary: Record<string, { count: number; versions: Record<string, number> }>;
}): string {
    const { metadata, modules, summary } = result;
    const rows = modules.map(m =>
        `<tr><td>${m.name}</td><td>${m.source}</td><td>${m.version || ''}</td><td>${m.repository}</td><td>${m.filePath}</td><td><a href="${m.fileUrl}#L${m.lineNumber}">${m.lineNumber}</a></td></tr>`
    ).join('');
    const summaryItems = Object.entries(summary)
        .map(([src, info]) => `<li>${src} - ${info.count} use${info.count === 1 ? '' : 's'}</li>`)
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Terraform Module Report</title>
    <style>
        body{font-family:Arial,Helvetica,sans-serif;margin:1em;}
        table{border-collapse:collapse;width:100%;}
        th,td{border:1px solid #ccc;padding:4px;}
        th{background:#eee;}
    </style>
</head>
<body>
    <h1>Terraform Module Usage Report</h1>
    <p><strong>Owner:</strong> ${metadata.owner}</p>
    <p><strong>Repository:</strong> ${metadata.repository}</p>
    <p><strong>Modules found:</strong> ${metadata.moduleCount}</p>
    <p><strong>Files analyzed:</strong> ${metadata.fileCount}</p>
    <h2>Modules</h2>
    <table>
        <thead><tr><th>Name</th><th>Source</th><th>Version</th><th>Repository</th><th>File</th><th>Line</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
    <h2>Summary</h2>
    <ul>${summaryItems}</ul>
</body>
</html>`;
}

/**
 * Set up command line interface
 */
program
    .name('terrawiz')
    .description('Track Terraform modules used in GitHub repositories')
    .version('1.0.0');

program
    .command('scan')
    .description('Scan and analyze Terraform modules in GitHub repositories')
    .requiredOption('--org <organization>', 'GitHub organization or user name')
    .option('--repo <repository>', 'Specific repository name (if not provided, will search the entire organization)')
    .option('--format <format>', 'Output format: json, csv, table, or html (default: table)', 'table')
    .option('--output <filepath>', 'Export results to specified file')
    .option('--debug', 'Enable debug logging')
    .option('--max-repos <number>', 'Maximum number of repositories to process')
    .option('--no-rate-limit', 'Disable rate limit protection')
    .option('--skip-archived', 'Skip archived repositories (default: true)', true)
    .action(async (options) => {
        try {
            // Configure logging based on debug flag
            if (options.debug) {
                Logger.getInstance({ level: LogLevel.DEBUG });
                logger.debug('Debug logging enabled');
            }

            // Parse API limits options
            let maxRepos: number | null = null;
            if (options.maxRepos) {
                maxRepos = parseInt(options.maxRepos, 10);
                if (isNaN(maxRepos) || maxRepos < 1) {
                    logger.error('Error: max-repos must be a positive number');
                    process.exit(1);
                }
                logger.info(`Limiting search to ${maxRepos} repositor${maxRepos === 1 ? 'y' : 'ies'}`);
            }

            // Fixed perPage to 100 (max allowed by GitHub API)
            const perPage = 100;

            // Configure GitHub service
            const githubServiceOptions: GitHubServiceOptions = {
                debug: options.debug,
                useRateLimit: options.rateLimit !== false,
                skipArchived: options.skipArchived
            };

            // Initialize services
            const githubService = new GitHubService(githubServiceOptions);
            const terraformParser = new TerraformParser();

            logger.info(`Scanning for Terraform files in ${options.org}${options.repo ? `/${options.repo}` : ''}`);

            // Get Terraform files using the repository tree approach
            logger.info('Getting repositories and extracting Terraform files...');
            const files = await githubService.findTerraformFiles(options.org, options.repo, maxRepos, perPage);

            if (files.length === 0) {
                logger.info('No Terraform files found');
                return;
            }

            logger.info(`Found ${files.length} Terraform files. Analyzing module usage...`);

            // Extract module information
            const modules = terraformParser.parseModules(files);

            if (modules.length === 0) {
                logger.info('No Terraform modules found');
                return;
            }

            logger.info(`Found ${modules.length} Terraform module references`);

            // Create summary
            const summary = terraformParser.createModuleSummary(modules);

            // Output results
            const result = {
                metadata: {
                    owner: options.org,
                    repository: options.repo || 'All repositories',
                    timestamp: new Date().toISOString(),
                    moduleCount: modules.length,
                    fileCount: files.length
                },
                modules,
                summary
            };

            // Prepare the output data based on format
            let outputData: string = '';
            switch (options.format.toLowerCase()) {
                case 'json':
                    outputData = JSON.stringify(result, null, 2);
                    break;
                case 'csv':
                    outputData = 'module,source_type,version,repository,file_path,line_number,github_link\n' +
                        modules.map(m => {
                            const githubLink = `${m.fileUrl}#L${m.lineNumber}`;
                            return `"${m.source}","${m.sourceType}","${m.version || ''}","${m.repository}","${m.filePath}",${m.lineNumber},"${githubLink}"`;
                        }).join('\n');
                    break;
                case 'html':
                case 'web':
                    outputData = generateHtmlReport(result);
                    break;
                case 'table':
                default:
                    const tableLines = [
                        '\nTerraform Module Usage Report',
                        '============================',
                        `Scope: ${options.org}${options.repo ? `/${options.repo}` : ' (organization)'}`,
                        `Total modules found: ${modules.length}`,
                        `Total files analyzed: ${files.length}`,
                        '\nModule Summary by Source:'
                    ];

                    // Sort by frequency
                    const sortedSources = Object.entries(summary)
                        .sort(([, a], [, b]) => b.count - a.count);

                    for (const [source, info] of sortedSources) {
                        // Find the source type by looking at the first module with this source
                        const sourceType = modules.find(m => m.source === source)?.sourceType || 'unknown';
                        tableLines.push(`\n${source} (${info.count} instances, type: ${sourceType})`);

                        if (Object.keys(info.versions).length > 0) {
                            tableLines.push('  Versions:');
                            Object.entries(info.versions)
                                .sort(([, a], [, b]) => b - a)
                                .forEach(([version, count]) => {
                                    tableLines.push(`    - ${version}: ${count} instances`);
                                });
                        } else {
                            tableLines.push('  No version constraints found');
                        }
                    }

                    // Additional summary by source type
                    tableLines.push('\nModules by Source Type:');
                    const typeCount = modules.reduce((acc, module) => {
                        acc[module.sourceType] = (acc[module.sourceType] || 0) + 1;
                        return acc;
                    }, {} as Record<string, number>);

                    Object.entries(typeCount)
                        .sort(([, a], [, b]) => b - a)
                        .forEach(([type, count]) => {
                            tableLines.push(`  ${type}: ${count} modules (${(count / modules.length * 100).toFixed(1)}%)`);
                        });

                    outputData = tableLines.join('\n');
            }

            // Export results if requested or print to console if not exporting
            if (options.output) {
                const exportPath = path.resolve(options.output);
                fs.writeFileSync(exportPath, outputData);
                logger.info(`Results exported to ${exportPath}`);
            } else {
                // Only print to console if not exporting
                console.log(outputData);
            }
        } catch (error) {
            logger.errorWithStack('Application error', error as Error);
            process.exit(1);
        }
    });

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:');
    logger.error(reason as string);
    process.exit(1);
});

program.parse(process.argv);