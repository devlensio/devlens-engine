from models.user import User

def test_create():
    u = User.create(1)
    assert u.to_dict() == {"id": 1}
