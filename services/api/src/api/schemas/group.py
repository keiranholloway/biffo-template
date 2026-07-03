from pydantic import BaseModel


class GroupListResponse(BaseModel):
    """The Cognito groups a user can be assigned to on this deployment.

    Names only — the portal uses them to populate its group picker (issue #148).
    """

    groups: list[str]
