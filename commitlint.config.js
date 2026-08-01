// GitHub skips every workflow for a push whose commit message contains a
// CI-skip token — anywhere in the message, subject or body, in prose or inside
// backticks. That is a useful feature in the subject and a trap in the body.
//
// It cost real time on 2026-08-01: the commit *implementing* the sibling
// scaffold's deliberate skip-ci marker explained itself in its own body, so
// **zero workflow runs were created**. The PR sat BLOCKED on required checks
// that could never arrive, `gh run list --branch <it>` was empty while every
// other branch got runs normally, and closing and reopening the PR did not
// help — only amending the message and force-pushing did. Nothing about the
// symptom points at the cause, which is what makes it worth a machine check
// rather than a line of prose someone has to remember.
//
// The split below matches intent exactly:
//   - SUBJECT -> allowed. Putting it there is a deliberate "skip CI for this
//     commit", which is a real thing to want and is visible in one line.
//   - BODY -> rejected. Nobody writes a skip token into a body to skip CI;
//     they write it because they are *explaining* one. That is the accidental
//     case, and it is invisible until you notice the absence of a run.
//
// Write "the skip-ci marker" in prose instead. To genuinely skip CI, put the
// token in the subject.
const CI_SKIP_TOKENS = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]']

const noCiSkipTokenInBody = {
  rules: {
    'body-no-ci-skip-token': (parsed) => {
      const body = (parsed.body ?? '').toLowerCase()
      const found = CI_SKIP_TOKENS.filter((token) => body.includes(token))
      if (found.length === 0) return [true, '']
      return [
        false,
        `commit body contains ${found.join(', ')} — GitHub reads the whole message, so ` +
          'this silently skips every workflow and the PR then waits for required checks ' +
          'that will never run. Write "the skip-ci marker" in prose; put the token in the ' +
          'SUBJECT if you actually mean to skip CI.',
      ]
    },
  },
}

module.exports = {
  extends: ['@commitlint/config-conventional'],
  plugins: [noCiSkipTokenInBody],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'docs', 'test', 'infra', 'security', 'refactor', 'perf', 'ci'],
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 100],
    'body-no-ci-skip-token': [2, 'always'],
  },
}
