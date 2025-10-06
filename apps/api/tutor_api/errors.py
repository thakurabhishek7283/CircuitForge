"""Every error body is an `ApiError {code, message, retryable}` (wire type, LLD §5)."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .models.contract import ApiError


class ApiException(Exception):
    def __init__(self, status: int, code: str, message: str, *, retryable: bool = False):
        super().__init__(f"{code}: {message}")
        self.status = status
        self.error = ApiError(code=code, message=message, retryable=retryable)


def not_found(what: str) -> ApiException:
    # Another user's project or job is "not found" too: its existence is not revealed.
    return ApiException(404, "not_found", f"{what} not found")


def body(e: ApiError) -> dict:
    return e.model_dump(mode="json")


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiException)
    async def api_exception(_: Request, e: ApiException) -> JSONResponse:
        return JSONResponse(body(e.error), status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, e: RequestValidationError) -> JSONResponse:
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        message = f"{where}: {first.get('msg', 'invalid request')}" if where else "invalid request"
        return JSONResponse(body(ApiError(code="invalid_request", message=message)), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_exception(_: Request, e: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed", 401: "unauthorized"}.get(e.status_code, "http_error")
        return JSONResponse(body(ApiError(code=code, message=str(e.detail))), status_code=e.status_code)
