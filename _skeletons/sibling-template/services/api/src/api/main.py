import asyncio

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from .config import settings
from .routers import whoami

logger = Logger()
tracer = Tracer()

app = FastAPI(
    title="Sibling API",
    version="0.0.0",
    docs_url="/api/docs" if settings.environment != "prod" else None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(whoami.router, prefix="/api/v1")

handler = Mangum(app, lifespan="off")


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    # asyncio.run() (used internally by httpx's async client teardown, among
    # other things) sets the current event loop to None when it exits,
    # causing asyncio.get_event_loop() (used by Mangum) to raise RuntimeError
    # in Python 3.12+. Recreate the loop before each invocation.
    asyncio.set_event_loop(asyncio.new_event_loop())
    return handler(event, context)  # type: ignore[reportArgumentType]
