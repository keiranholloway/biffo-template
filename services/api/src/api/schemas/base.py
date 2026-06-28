from datetime import datetime

from pydantic import BaseModel, ConfigDict


class BiffoBaseSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    tenant_id: str
    created_at: datetime
    updated_at: datetime
