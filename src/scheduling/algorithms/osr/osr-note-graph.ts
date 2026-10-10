import * as graph from "pagerank.js";

import { INoteEaseList } from "src/note/note-ease-list";
import { IOsrVaultNoteLinkInfoFinder } from "src/scheduling/algorithms/osr/obsidian-vault-notelink-info-finder";
import { isSupportedFileType } from "src/utils/fs";

export interface LinkStat {
    sourcePath: string;
    linkCount: number;
}

export interface NoteLinkStat {
    linkTotal: number;
    linkPGTotal: number;
    totalLinkCount: number;
}

export class OsrNoteGraph {
    private vaultNoteLinkInfoFinder: IOsrVaultNoteLinkInfoFinder;
    // Key: targetFilename
    // Value: Map<sourceFilename, linkCount>
    // This is the number of links from sourceFilename to targetFilename
    // For simplicity, we just store the filename without the directory or filename extension
    incomingLinks: Record<string, LinkStat[]> = {};
    pageranks: Record<string, number> = {};
    private outgoingLinks: Record<string, Record<string, number>> = {};

    constructor(vaultNoteLinkInfoFinder: IOsrVaultNoteLinkInfoFinder) {
        this.vaultNoteLinkInfoFinder = vaultNoteLinkInfoFinder;
        this.reset();
    }

    reset() {
        this.incomingLinks = {};
        this.pageranks = {};
        this.outgoingLinks = {};
        graph.reset();
    }

    processLinks(path: string) {
        this.outgoingLinks[path] = {
            ...(this.vaultNoteLinkInfoFinder.getResolvedTargetLinksForNotePath(path) || {}),
        };
    }

    removePath(path: string): void {
        delete this.outgoingLinks[path];
    }

    calcNoteLinkStat(notePath: string, noteEaseList: INoteEaseList): NoteLinkStat {
        let linkTotal = 0,
            linkPGTotal = 0,
            totalLinkCount = 0;

        for (const statObj of this.incomingLinks[notePath] || []) {
            const ease: number | null = noteEaseList.getEaseByPath(statObj.sourcePath);
            if (ease) {
                linkTotal += statObj.linkCount * this.pageranks[statObj.sourcePath] * ease;
                linkPGTotal += this.pageranks[statObj.sourcePath] * statObj.linkCount;
                totalLinkCount += statObj.linkCount;
            }
        }

        const outgoingLinks =
            this.vaultNoteLinkInfoFinder.getResolvedTargetLinksForNotePath(notePath) || {};
        for (const outgoingLink in outgoingLinks) {
            const ease: number | null = noteEaseList.getEaseByPath(outgoingLink);
            const linkCount: number = outgoingLinks[outgoingLink];
            const pageRank: number = this.pageranks[outgoingLink];
            if (ease) {
                linkTotal += linkCount * pageRank * ease;
                linkPGTotal += pageRank * linkCount;
                totalLinkCount += linkCount;
            }
        }

        return { linkTotal, linkPGTotal, totalLinkCount };
    }

    generatePageRanks() {
        this.incomingLinks = {};
        this.pageranks = {};
        graph.reset();

        for (const sourcePath of Object.keys(this.outgoingLinks)) {
            if (this.incomingLinks[sourcePath] === undefined) {
                this.incomingLinks[sourcePath] = [];
            }
            for (const [targetPath, linkCount] of Object.entries(this.outgoingLinks[sourcePath])) {
                if (!isSupportedFileType(targetPath)) continue;
                if (this.incomingLinks[targetPath] === undefined) {
                    this.incomingLinks[targetPath] = [];
                }
                this.incomingLinks[targetPath].push({ sourcePath, linkCount });
                graph.link(sourcePath, targetPath, linkCount);
            }
        }

        graph.rank(0.85, 0.000001, (node: string, rank: number) => {
            this.pageranks[node] = rank * 10000;
        });
    }
}
