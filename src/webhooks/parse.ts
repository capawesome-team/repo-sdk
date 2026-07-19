/**
 * A push that deletes its ref reports an all-zero object id; normalize that to
 * undefined so `headCommitSha` is only set when the ref still points at a commit.
 */
export function headShaOrUndefined(sha: string | undefined): string | undefined {
  if (!sha || /^0+$/.test(sha)) return undefined;
  return sha;
}
