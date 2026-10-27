import { resolve, sep } from "node:path";
import type { ArchiveSearchResult } from "../schema/index.js";
import type { ArchiveAttachmentHit, ArchiveDb, Board } from "../store/archive-db.js";

export interface ArchiveSearchInput {
  kind: "assignments" | "posts";
  course?: string;
  query?: string;
  board?: Board;
  status?: string;
  dueFrom?: string;
  dueTo?: string;
  limit: number;
}

const EXCERPT_MAX = 300;
export const EMPTY_ARCHIVE_NOTE = "아카이브가 비어 있습니다. 먼저 sync_eclass를 실행하세요.";

/** 공백을 한 칸으로 줄이고 300자로 자른다. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? flat.slice(0, EXCERPT_MAX) : flat;
}

/** 첨부를 출력 형태로 바꾼다. 원본 URL·오류는 싣지 않고, files 디렉터리 밖으로 나가는 경로는 null로 둔다. */
function attachments(list: ArchiveAttachmentHit[], filesDir: string) {
  const root = resolve(filesDir);
  return list.map((a) => {
    const abs = a.localPath === null ? undefined : resolve(root, a.localPath);
    const localPath = abs !== undefined && abs.startsWith(root + sep) ? abs : null;
    return { name: a.name, localPath, downloaded: localPath !== null };
  });
}

/** 로컬 아카이브 DB 검색(포털 요청 없음). */
export function searchArchive(db: ArchiveDb, filesDir: string, input: ArchiveSearchInput): ArchiveSearchResult {
  if (!db.hasCourses()) return { kind: input.kind, total: 0, items: [], note: EMPTY_ARCHIVE_NOTE };
  if (input.kind === "posts") {
    const { total, items } = db.searchPosts({
      course: input.course,
      query: input.query,
      board: input.board,
      limit: input.limit,
    });
    return {
      kind: "posts",
      total,
      items: items.map((p) => ({
        lectureSeq: p.lectureSeq,
        courseName: p.courseName,
        board: p.board,
        wrId: p.wrId,
        title: p.title,
        postedAt: p.postedAt,
        author: p.author,
        bodyExcerpt: excerpt(p.bodyText),
        attachments: attachments(p.attachments, filesDir),
      })),
    };
  }
  const { total, items } = db.searchAssignments({
    course: input.course,
    query: input.query,
    status: input.status,
    dueFrom: input.dueFrom,
    dueTo: input.dueTo,
    limit: input.limit,
  });
  return {
    kind: "assignments",
    total,
    items: items.map((a) => ({
      lectureSeq: a.lectureSeq,
      courseName: a.courseName,
      reportSeq: a.reportSeq,
      title: a.title,
      startAt: a.startAt,
      dueAt: a.dueAt,
      extendedDueAt: a.extendedDueAt,
      submitStatus: a.submitStatus,
      contentExcerpt: excerpt(a.contentText),
      attachments: attachments(a.attachments, filesDir),
      ...(a.submission && {
        submission: {
          title: a.submission.title,
          contentExcerpt: excerpt(a.submission.contentText),
          attachments: attachments(a.submission.attachments, filesDir),
        },
      }),
    })),
  };
}
