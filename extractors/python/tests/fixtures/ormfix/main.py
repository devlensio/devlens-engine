from fastapi import FastAPI

from .crud import create_user, get_user
from .db import get_session

app = FastAPI()


@app.get("/users/{user_id}")
def read_user(user_id: int):
    return get_user(get_session(), user_id)


@app.post("/users")
def add_user(name: str):
    return create_user(get_session(), name)
