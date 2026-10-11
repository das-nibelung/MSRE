import { TFile, Vault } from "obsidian";

import {
    FILE_NATIVE_CATALOG_PATH,
    FileNativeCatalog,
    FileNativeDocument,
    formatFileNativeCatalog,
    parseFileNativeCatalog,
    readFileNativeDocument,
} from "src/data/file-native/file-native-format";

export class FileNativeStore {
    private lastCatalog = "";

    constructor(private readonly vault: Vault) {}

    resetCatalogCache(): void {
        this.lastCatalog = "";
    }

    async readCatalog(): Promise<FileNativeCatalog | null> {
        const file = this.vault.getAbstractFileByPath(FILE_NATIVE_CATALOG_PATH);
        if (!(file instanceof TFile)) return null;
        const contents = await this.vault.read(file);
        this.lastCatalog = contents;
        return parseFileNativeCatalog(contents);
    }

    async writeCatalog(catalog: FileNativeCatalog): Promise<void> {
        const contents = formatFileNativeCatalog(catalog);
        if (contents === this.lastCatalog) return;
        await this.ensureFolder(FILE_NATIVE_CATALOG_PATH.split("/").slice(0, -1).join("/"));
        const file = this.vault.getAbstractFileByPath(FILE_NATIVE_CATALOG_PATH);
        if (file instanceof TFile) await this.vault.modify(file, contents);
        else await this.vault.create(FILE_NATIVE_CATALOG_PATH, contents);
        this.lastCatalog = contents;
    }

    async readDocument(file: TFile): Promise<FileNativeDocument | null> {
        return readFileNativeDocument(await this.vault.read(file));
    }

    async readAllDocuments(): Promise<Array<{ path: string; manifest: FileNativeDocument }>> {
        const results: Array<{ path: string; manifest: FileNativeDocument }> = [];
        const files = this.vault
            .getMarkdownFiles()
            .filter((file) => file.path !== FILE_NATIVE_CATALOG_PATH);
        // Keep startup bounded on large vaults while avoiding a slow serial read per card file.
        for (let offset = 0; offset < files.length; offset += 64) {
            const batch = files.slice(offset, offset + 64);
            const manifests = await Promise.all(batch.map((file) => this.readDocument(file)));
            manifests.forEach((manifest, index) => {
                if (manifest) results.push({ path: batch[index].path, manifest });
            });
        }
        return results;
    }

    private async ensureFolder(path: string): Promise<void> {
        let current = "";
        for (const part of path.split("/").filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!this.vault.getAbstractFileByPath(current)) await this.vault.createFolder(current);
        }
    }
}
