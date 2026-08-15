import os
from fastapi import FastAPI
from models.user import User

app = FastAPI()

@app.get("/users/{user_id}")
def get_user(user_id: int):
    user = User(user_id)
    return user.to_dict()

def helper(x):
    def inner():
        return 1
    return inner() + x
