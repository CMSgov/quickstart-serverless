// Our data source is Security Hub Findings.  Auth is provided via the lambda's IAM role.
import AWS from "aws-sdk";
const securityhub = new AWS.SecurityHub();

// The GitHub org/owner and repo for which we're modifying issues
const org = process.env.githubRepository.split("/")[0];
const repo = process.env.githubRepository.split("/")[1];

// The repository project boards to which we want to add issues.
const repoProjects = process.env.githubRepositoryProjects
  .split(",")
  .filter(Boolean);

// The organization project boards to which we want to add issues.
const orgProjects = process.env.githubOrganizationProjects
  .split(",")
  .filter(Boolean);

// The stage variable maps to an environment, and will be used in the issue title.
const stage = process.env.stage;

// Octokit is the offical client(s) for the GitHub API.
import { Octokit } from "octokit";
// We auth to the GitHub API via a personal access token.
const octokit = new Octokit({ auth: process.env.githubAccessToken });
// Org/owner and repo params used in Octokit requests.
const octokitRepoParams = {
  owner: org,
  repo: repo,
};

// We will use lodash to do some filtering/searching.
const _ = require("lodash");

// Regex used to search a GitHub Issue's body to find the Id of its underlying Security Hub Finding.
const findingIdRegex = /(?<=\nFinding Id: ).*/g;

async function getAllActiveFindings() {
  const EMPTY = Symbol("empty");
  const res = [];
  let severityLabels = [];
  process.env.severity.split(",").forEach(function (label) {
    severityLabels.push({
      Comparison: "EQUALS",
      Value: label,
    });
  });

  // prettier-ignore
  for await (const lf of (async function * () {
    let NextToken = EMPTY;
    while (NextToken || NextToken === EMPTY) {
      const functions = await securityhub
        .getFindings({
          Filters: {
            RecordState: [
              {
                Comparison: "EQUALS",
                Value: "ACTIVE",
              },
            ],
            SeverityLabel: severityLabels,
          },
          MaxResults: 100,
          NextToken: NextToken !== EMPTY ? NextToken : undefined,
        })
        .promise();
      yield* functions.Findings;
      NextToken = functions.NextToken;
    }
  })()) {
    res.push(lf);
  }
  return res;
}

async function getAllIssues() {
  let issues = [];
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      ...octokitRepoParams,
      state: "all",
      labels: ["security-hub"],
    }
  )) {
    issues.push(...response.data);
  }
  return issues;
}

function issueParamsForFinding(finding) {
  return {
    title: `SHF - ${repo} - ${stage} - ${finding.Severity.Label} - ${finding.Title}`,
    state: "open",
    labels: ["security-hub"],
    body: `**************************************************************
__This issue was generated from Security Hub data and is managed through automation.__
Please do not edit the title or body of this issue, or remove the security-hub tag.  All other edits/comments are welcome.
Finding Id: ${finding.Id}
**************************************************************


## Type of Issue:

- [x] Security Hub Finding

## Title:

${finding.Title}

## Id:

${finding.Id}
(You may use this ID to lookup this finding's details in Security Hub)

## Description

${finding.Description}

## Remediation

${finding.ProductFields.RecommendationUrl}

## AC:

- The security hub finding is resolved or suppressed, indicated by a Workflow Status of Resolved or Suppressed.
    `,
  };
}

async function createNewGitHubIssue(finding) {
  await octokit.rest.issues.create({
    ...octokitRepoParams,
    ...issueParamsForFinding(finding),
  });
  // Due to github secondary rate limiting, we will take a 5s pause after creating issues.
  // See:  https://docs.github.com/en/rest/overview/resources-in-the-rest-api#secondary-rate-limits
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

async function updateIssueIfItsDrifted(finding, issue) {
  let issueParams = issueParamsForFinding(finding);
  let issueLabels = [];
  issue.labels.forEach(function (label) {
    issueLabels.push(label.name);
  });
  if (
    issue.title != issueParams.title ||
    issue.state != issueParams.state ||
    issue.body != issueParams.body ||
    !issueParams.labels.every((v) => issueLabels.includes(v))
  ) {
    console.log("...Issue drift detected.  Updating issue...");
    await octokit.rest.issues.update({
      ...octokitRepoParams,
      ...issueParams,
      issue_number: issue.number,
    });
  } else {
    console.log("...Issue is correctly configured.  Doing nothing...");
  }
}

async function closeIssuesWithoutAnActiveFinding(findings, issues) {
  // Search for open issues that do not have a corresponding active SH finding.
  for (let i = 0; i < issues.length; i++) {
    let issue = issues[i];
    if (issue.state != "open") continue; // We only care about open issues here.
    console.log(`Starting loop for issue:  ${issue.number}`);
    let hit = false;
    let issueId = issue.body.match(findingIdRegex);
    for (let j = 0; j < findings.length; j++) {
      let finding = findings[j];
      if (finding.Id == issueId) {
        console.log(
          "...Issue has a corresponding active finding.  Doing nothing..."
        );
        hit = true;
        break;
      }
    }
    if (!hit) {
      console.log(
        "...Issue does not have a current active finding.  Closing issue..."
      );
      await octokit.rest.issues.update({
        ...octokitRepoParams,
        issue_number: issue.number,
        state: "closed",
      });
    }
  }
}

async function createOrUpdateIssuesBasedOnFindings(findings, issues) {
  // Search for active SH findings that don't have an open issue
  for (let i = 0; i < findings.length; i++) {
    var finding = findings[i];
    console.log(`Starting loop for finding:  ${finding.Id}`);
    let hit = false;
    for (let j = 0; j < issues.length; j++) {
      var issue = issues[j];
      let issueId = issue.body.match(findingIdRegex);
      if (finding.Id == issueId) {
        hit = true;
        console.log(
          "...GitHub Issue found for this finding.  Updating issue if it has drifted..."
        );
        await updateIssueIfItsDrifted(finding, issue);
        break;
      }
    }
    if (!hit) {
      console.log(`...No issue found for ${finding.Id}.  Creating issue...`);
      await createNewGitHubIssue(finding);
    }
  }
}

async function assignIssuesToProject(issues, projectId, defaultColumnName) {
  // Get information on any/all columns in the target project.
  var targetProjectColumns = (
    await octokit.rest.projects.listColumns({
      project_id: projectId,
    })
  ).data;

  // Store the default column's id in a variable.  This is used later to add cards to the Project.
  var defaultColumnId = _.find(
    targetProjectColumns,
    "name",
    defaultColumnName
  ).id;

  // Store the Project's columns' ids in an array
  var targetColumnIds = _.map(targetProjectColumns, "id");

  // Iterate over the Project's columns, and put all cards into a single array.
  var projectCards = [];
  for (let i = 0; i < targetColumnIds.length; i++) {
    let cards = (
      await octokit.rest.projects.listCards({
        column_id: targetColumnIds[i],
      })
    ).data;
    projectCards.push(...cards);
  }

  // Iterate over the issues; if the card is not anywhere on the board, add it to the default column.
  for (let i = 0; i < issues.length; i++) {
    let issue = issues[i];
    if (issue.state != "open") continue; // We only care about open issues here.
    console.log(`Starting loop for issue:  ${issue.number}`);
    if (
      !_.find(projectCards, function (x) {
        return x.content_url == issue.url;
      })
    ) {
      console.log("Issue not assigned to Project.  Adding issue...");
      await octokit.rest.projects.createCard({
        column_id: defaultColumnId,
        content_id: issue.id,
        content_type: "Issue",
      });
    } else {
      console.log("Issue already assigned to Project.  Doing nothing...");
    }
  }
}

async function assignIssuesToRepositoryProjects(issues, projects) {
  // Find all Projects for the given repository
  var repoProjects = (
    await octokit.rest.projects.listForRepo(octokitRepoParams)
  ).data;

  for (let i = 0; i < projects.length; i++) {
    // Find the target Project by name
    var targetProject = _.find(repoProjects, function (x) {
      return x.name == projects[i];
    });
    await assignIssuesToProject(issues, targetProject.id, "To Do");
  }
}

async function assignIssuesToOrganizationProjects(issues, projects) {
  // Find all Projects for the given repository
  var orgProjects = (await octokit.rest.projects.listForOrg({ org: org })).data;
  for (let i = 0; i < projects.length; i++) {
    // Find the target Project by name
    var targetProject = _.find(orgProjects, function (x) {
      return x.name == projects[i];
    });
    await assignIssuesToProject(issues, targetProject.id, "To Do");
  }
}

async function scan(event) {
  const findings = await getAllActiveFindings();
  var issues = await getAllIssues();
  await closeIssuesWithoutAnActiveFinding(findings, issues);
  await createOrUpdateIssuesBasedOnFindings(findings, issues);
  issues = await getAllIssues(); // Refetch all issues before assigning to projects
  await assignIssuesToRepositoryProjects(issues, repoProjects);
  await assignIssuesToOrganizationProjects(issues, orgProjects);
}

exports.main = scan;
