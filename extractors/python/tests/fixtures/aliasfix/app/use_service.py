from .services import UserService as US


def load(user_id):
    return US.get(user_id)
