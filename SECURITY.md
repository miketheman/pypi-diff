# Security policy

## Scope

This policy covers pypi-diff itself: the code in this repository and the site at <https://miketheman.github.io/pypi-diff/>.

In scope are flaws in the tool, for example:

- a package whose contents run script in the page, or make it send requests anywhere other than `pypi.org` and `files.pythonhosted.org`
- a package that makes the tool hide, misreport or mislabel its contents
- a flaw in `serve.py`, the local development server

## Out of scope: the packages you look at

pypi-diff displays packages. It does not host them, vouch for them or control them.

Do not report a malicious, suspicious, typosquatting or vulnerable package here. That includes anything you found by using this tool. Nobody here can act on such a report.

- To report malware or abuse on PyPI, use the "Report project as malware" link on the project's pypi.org page, or see <https://pypi.org/security/>.
- To report a vulnerability in a package, contact that package's maintainers.

Reports about packages will be closed without a reply, and the accounts that file them will be blocked from this repository.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Do not open a public issue for a security problem.

Include the two packages or file URLs you compared, what you expected, and what happened. A link produced by the tool is the fastest way to reproduce it.

This is a personal project maintained in spare time, so there is no guaranteed response time.
