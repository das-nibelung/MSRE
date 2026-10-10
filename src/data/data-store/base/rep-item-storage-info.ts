export class RepItemStorageInfo {
    notePath: string | null = null;
    questionHash: string | null = null;
    questionId: string | null = null;

    constructor(notePath?: string, questionHash?: string, questionId?: string) {
        this.notePath = notePath || null;
        this.questionHash = questionHash || null;
        this.questionId = questionId || null;
    }
}
