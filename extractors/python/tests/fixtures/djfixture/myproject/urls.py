from django.urls import include, path
from app import views

urlpatterns = [
    path("users/<int:user_id>/", views.get_user, name="get_user"),
    path("api/", include("app.urls")),
]
