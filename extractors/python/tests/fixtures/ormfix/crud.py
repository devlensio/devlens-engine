from sqlalchemy import select

from .db import get_session
from .models import Post, User


def get_user(session, user_id):
    return session.query(User).filter(User.id == user_id).first()


def create_user(session, name):
    user = User(name=name)
    session.add(user)
    session.commit()
    return user


def list_posts(session):
    stmt = select(Post)
    return session.execute(stmt)
